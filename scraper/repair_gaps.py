"""取りこぼし（欠損データ）を検出して取り直す補修スクリプト。

通常の取得経路（daily-sync.yml の winticket_scraper.py --all-venues --days-back 1 と、
sync-results.yml の sync_results_only.py）は「速さ」を優先しており、次のような
経路で取りこぼしたデータは二度と取り直されない:
  - daily-syncの窓（days_back + CUP_LOOKBACK_DAYS ≒ 8日）より古いレースは、
    着順・払戻が欠けていても再取得されない。
  - 途中のレースで取得に失敗すると、その日の取得はそこで打ち切られる。取得済みの
    前半レースの着順が揃っていると load_completed_days が「その日は完了」と判定し、
    後半レースが永久に取得されない（日の途中で切れた状態）。
  - 日程ページや1Rの取得失敗（429・通信エラー）で、開催の1日分・開催まるごとが
    DBに1件も入らないことがある。
  - load_completed_days は着順しか見ないため、払戻(3連単)だけ欠けたレースを含む日も
    「完了」扱いになりスキップされる。
  - 出走表の保存（races行のINSERTとentriesのbatchは別送信）に失敗すると、
    races行だけあってentriesが無いレースが残る。
  - sync_results_only.py は「JST当日」しか見ないため、日付をまたいで確定する
    ミッドナイトの最終レースは daily-sync 頼みになる。

このスクリプトは直近N日（既定30日）を対象に、DBへの問い合わせ2回だけで欠損を検出し、
必要なHTTPリクエストだけを送って補修する。何度実行しても同じ結果になる（冪等）。
検出の内訳:
  (a) レース単位: 発走+30分を過ぎたのに、3着までの着順が3件未満、または3連単の
      払戻行が無いレース → 結果ページだけ取り直す。
  (c) 出走表(entries)が1件も無いレース → 出走表から取り直す。
  (b) 開催単位: DBに無いレース・日程・開催そのもの。出走表ページには開催全体の
      レース一覧（全日程×全レース番号、発走時刻、中止フラグ）がJSONで埋め込まれて
      いるため、1開催につき出走表1ページ取得するだけでDBとの差分が正確に分かる。
      毎回全開催を確かめると重いので、次の開催だけ確かめる:
        - DB上の形が怪しい開催（レース番号・日程の歯抜け、他の日より最終Rが少ない日、
          2日以下で終わっている開催）
        - 前日以降にレースがあった開催（取りこぼしが起きやすい直近分。翌朝の前日
          サマリー集計より前に埋めたい）
        - 残りの開催は巡回（cup_idで--sweep-slices等分し、実行ごとに順番に確認）
        - 日程キャッシュ（wt_schedule_cache、daily-syncが日次で更新）にあるのに
          DBに1レースも無い開催
DB書き込みの方針:
  - 結果だけ取り直す場合は results/odds のみ書く（sync_results_only.pyと同じ方針。
    racers/entriesを触らない）。
  - 出走表から取り直す場合も racers は「無ければ作るだけ」で既存行は更新しない。
    racers は「現在の」成績としてライブ予想（lib/repository.ts getEntriesForRace）が
    読むため、過去レースの出走表の値で上書きすると最新値が古い値に戻ってしまう
    （save_to_dbを使わない理由）。entries/racer_interviewsも既存行は触らない。
  - 選手の直近成績（racer_race_history）は補修では取りに行かない。レース単位の
    データではなく「現在の調子」なので、出走前のレースを扱うdaily-sync側の仕事。
  - odds（払戻）は同じ組み合わせが既にあれば入れない形で書く（一意インデックスあり）。
  - 中止と判明したレースは races.cancelled を立て、以後の検出対象から外す。

使い方:
    python repair_gaps.py                 # 直近30日を補修
    python repair_gaps.py --dry-run       # 検出と確認だけ（DBに書かない。HTTPは送る）
    python repair_gaps.py --sweep-all     # 巡回を待たず全開催をレース一覧と突き合わせる
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime
import json
import os
import sys
import threading
import zlib
from dataclasses import dataclass, field
from typing import Any

from db import get_client
from keirin_scraper import RaceData
from sync_results_only import parse_encp
from winticket_scraper import (
    CUP_LOOKBACK_DAYS,
    JOCD_TO_WINTICKET_SLUG,
    JST,
    _get,
    _sleep,
    iter_state_dicts as _iter_dicts,
    load_preloaded_state as _load_state,
    mark_race_cancelled,
    parse_interviews,
    parse_race_cancelled,
    parse_racecard,
    parse_raceresult,
    state_int as _to_int,
)

DEFAULT_DAYS = 30
# 発走からこの分数が経ったレースだけを「確定しているはず」とみなす。WINTICKET側の
# 結果反映には数分のラグがあり（sync_results_only.py参照）、確定前に見ても空振りになる。
DUE_MARGIN_MIN = 30
# WINTICKETへの同時処理数。2026-10に8並列で429が返ったため控えめにする
# （リクエスト開始間隔は_get側が全スレッド合計で管理している）。
DEFAULT_WORKERS = 2
# 巡回の分割数。1日2回実行なら全開催を2日で一巡する。
DEFAULT_SWEEP_SLICES = 4
# 1回の実行で送るWINTICKETへのリクエスト上限。長期障害の後などに欠損が大量に
# 見つかっても1回で何千件も取りに行かないための安全弁（残りは次回に持ち越す）。
DEFAULT_MAX_REQUESTS = 1500
# この日数より古い欠損が補修できずに残ったら終了コード1にする（GitHub Actionsの
# 失敗通知で気付けるようにする）。直近分は次回の通常同期で埋まることが多いので除外。
DEFAULT_FAIL_AFTER_DAYS = 2
# マニフェストが読めなかった時に1Rから辿る上限（scrape_cupの既定値と同じ）。
MAX_DAYS_PER_CUP = 7
MAX_RACES_PER_DAY = 12

SANRENTAN = "3連単"
BUDGET_EXHAUSTED = -1



# ---------------------------------------------------------------------------
# 実行コンテキスト・集計
# ---------------------------------------------------------------------------

@dataclass
class RunContext:
    now: datetime.datetime
    since_str: str      # 補修対象の最古日（YYYYMMDD）
    today_str: str
    dry_run: bool


@dataclass
class GapResult:
    category: str       # "results" / "entries" / "missing"
    outcome: str        # "repaired" / "would_repair" / "cancelled" / "source_incomplete" / "failed"
    label: str
    kaisai_date: str
    detail: str = ""


CATEGORY_LABELS = {
    "results": "着順・払戻の欠け",
    "entries": "出走表(entries)の欠け",
    "missing": "DBに無いレース",
}
OUTCOME_ORDER = ["repaired", "would_repair", "cancelled", "source_incomplete", "failed"]
OUTCOME_LABELS = {
    "repaired": "補修",
    "would_repair": "補修予定(dry-run)",
    "cancelled": "中止",
    "source_incomplete": "WINTICKET側も欠け",
    "failed": "未補修",
}


class Report:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.items: list[GapResult] = []
        self.cups_verified = 0
        self.cups_unverified: list[str] = []

    def add(self, item: GapResult) -> None:
        with self._lock:
            self.items.append(item)
        print(f"  [{OUTCOME_LABELS[item.outcome]}] {CATEGORY_LABELS[item.category]}: {item.label}"
              + (f" … {item.detail}" if item.detail else ""))

    def cup_checked(self, ok: bool, label: str) -> None:
        with self._lock:
            if ok:
                self.cups_verified += 1
            else:
                self.cups_unverified.append(label)


class _RequestBudget:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.used = 0
        self._lock = threading.Lock()

    def take(self) -> bool:
        with self._lock:
            if self.used >= self.limit:
                return False
            self.used += 1
            return True


_budget = _RequestBudget(DEFAULT_MAX_REQUESTS)


def _fetch(url: str) -> tuple[int, str]:
    """共有の_get（再試行・429時の待機・全体の間隔制御込み）を上限付きで呼ぶ。"""
    if not _budget.take():
        return BUDGET_EXHAUSTED, ""
    status, body = _get(url)
    _sleep()
    return status, body


def _status_detail(page: str, status: int) -> str:
    if status == BUDGET_EXHAUSTED:
        return "リクエスト上限に達したため次回に持ち越し"
    return f"{page}取得失敗 status={status}"


# ---------------------------------------------------------------------------
# 時刻
# ---------------------------------------------------------------------------

def _race_start(kaisai_date: str | None, start_time: str | None) -> datetime.datetime | None:
    if not kaisai_date or not start_time:
        return None
    try:
        return datetime.datetime.strptime(f"{kaisai_date} {start_time}", "%Y%m%d %H:%M").replace(tzinfo=JST)
    except ValueError:
        return None


def _is_due(start: datetime.datetime | None, kaisai_date: str, ctx: RunContext) -> bool:
    """発走+DUE_MARGIN_MIN分を過ぎていればTrue。日付+時刻で比べるので、日付をまたいで
    確定するミッドナイトの最終レース（sync_results_only.pyの対象外）も拾える。"""
    if start is None:
        # 発走時刻が読めない場合は日付だけで判断する（前日以前なら確定済みのはず）
        return kaisai_date < ctx.today_str
    return start + datetime.timedelta(minutes=DUE_MARGIN_MIN) <= ctx.now


# ---------------------------------------------------------------------------
# DB読み取り（検出）
# ---------------------------------------------------------------------------

@dataclass
class DbRace:
    id: int
    encp: str
    cup_id: str
    day: int
    race_no: int
    kaisai_date: str
    start_time: str | None
    jocd: str
    keirinjo_name: str
    n_entries: int
    n_top3: int
    has_sanrentan: bool
    cancelled: bool = False

    @property
    def label(self) -> str:
        return f"{self.keirinjo_name} {self.kaisai_date} {self.race_no}R ({self.encp})"


# db.py の注意書きどおり、args付きのexecuteではSQL中の生の%がpsycopg2の書式指定子と
# 誤解釈されるため LIKE 'wt:%' ではなく substr で判定する。またbatch/executeは
# SQL中の?を全てプレースホルダに置換するので、SQL文字列の中には?を書かない。
WINDOW_RACES_SQL = """
SELECT r.id, r.encp, r.kaisai_date, r.start_time, r.jocd, r.keirinjo_name, r.race_no,
       (SELECT COUNT(*) FROM entries e WHERE e.race_id = r.id) AS n_entries,
       (SELECT COUNT(*) FROM results x
         WHERE x.race_id = r.id AND x.finish_pos BETWEEN 1 AND 3) AS n_top3,
       CASE WHEN EXISTS (SELECT 1 FROM odds o WHERE o.race_id = r.id AND o.bet_type = ?)
            THEN 1 ELSE 0 END AS has_sanrentan,
       r.cancelled
FROM races r
WHERE r.kaisai_date >= ? AND r.kaisai_date <= ? AND substr(r.encp, 1, 3) = 'wt:'
"""


def load_window_races(from_str: str, to_str: str) -> list[DbRace]:
    """検出クエリ1: 期間内の全WINTICKETレースを、出走数・3着内の着順数・3連単払戻の
    有無つきで1回で取る（レース単位の欠損判定と、開催の形の判定の両方に使う）。"""
    client = get_client()
    try:
        rows = client.execute(WINDOW_RACES_SQL, [SANRENTAN, from_str, to_str]).rows
    finally:
        client.close()
    races: list[DbRace] = []
    for row in rows:
        parsed = parse_encp(row[1])
        if parsed is None:
            continue
        cup_id, day, _encp_race_no = parsed
        races.append(DbRace(
            id=int(row[0]), encp=str(row[1]), cup_id=cup_id, day=day, race_no=int(row[6]),
            kaisai_date=str(row[2]), start_time=row[3], jocd=str(row[4]),
            keirinjo_name=str(row[5] or ""), n_entries=int(row[7]), n_top3=int(row[8]),
            has_sanrentan=bool(row[9]), cancelled=bool(row[10]),
        ))
    return races


def load_cached_cup_venues(from_yyyymm: str) -> dict[str, str] | None:
    """検出クエリ2: daily-syncが日次で更新している月間日程キャッシュ
    （winticket_scraper.load_schedule_cache参照）から cup_id → 開催場スラッグ を作る。
    日程ページをここで取り直さずに「開催まるごと未登録」を検出できる。
    テーブルがまだ無い（新しいdaily-syncが一度も走っていない）場合はNoneを返す。"""
    client = get_client()
    try:
        rows = client.execute(
            "SELECT venue, cup_ids FROM wt_schedule_cache WHERE yyyymm >= ?", [from_yyyymm]
        ).rows
    except Exception as exc:  # noqa: BLE001 - テーブル未作成などは検出の一部を諦めるだけにする
        print(f"  警告: 日程キャッシュを読めないため開催まるごとの未登録チェックは省略: {exc}")
        return None
    finally:
        client.close()
    cup_venues: dict[str, str] = {}
    for venue, cup_ids in rows:
        try:
            for cup_id in json.loads(cup_ids):
                cup_venues[str(cup_id)] = str(venue)
        except (TypeError, ValueError):
            continue
    return cup_venues


def load_entries_by_race(race_ids: list[int]) -> dict[int, dict[int, str]]:
    """結果を取り直すレースの出走表（車番→snum）。結果ページの車番をsnumに対応付けるのに使う。"""
    if not race_ids:
        return {}
    client = get_client()
    try:
        placeholders = ",".join("?" for _ in race_ids)
        rows = client.execute(
            f"SELECT race_id, car_num, snum FROM entries WHERE race_id IN ({placeholders})",
            race_ids,
        ).rows
    finally:
        client.close()
    out: dict[int, dict[int, str]] = {}
    for race_id, car_num, snum in rows:
        out.setdefault(int(race_id), {})[int(car_num)] = str(snum)
    return out


# ---------------------------------------------------------------------------
# WINTICKETページの解析（開催全体のレース一覧・中止フラグ）
# ---------------------------------------------------------------------------

@dataclass
class ManifestRace:
    day: int
    race_no: int
    date: str
    start_at: datetime.datetime | None
    cancelled: bool


def parse_cup_manifest(
    html: str, cup_id: str, db_day_by_date: dict[str, int]
) -> dict[tuple[int, int], ManifestRace] | None:
    """出走表ページに埋め込まれた開催全体のレース一覧を {(day, race_no): ManifestRace} で返す。

    stateの中に {"cup": {...}, "schedules": [{id, date, day, index}], "races": [{scheduleId,
    number, startAt, cancel, ...}]} という形のデータがあり（2026-10確認）、開催の全日程・
    全レース番号が1ページで分かる。見つからなければNone（呼び出し側は1Rから辿る代替に回る）。

    URLの日目（/racecard/{cup}/{day}/{R}）は既にDBにある同じ日付のencpに合わせる。
    DBに無い日付だけschedulesの index（無ければ day）を使う（両者は通常一致するが、
    順延などでずれた場合に実在するURLの方を優先するため）。
    """
    state = _load_state(html)
    if state is None:
        return None
    for node in _iter_dicts(state):
        schedules = node.get("schedules")
        races = node.get("races")
        if not (isinstance(schedules, list) and isinstance(races, list) and races):
            continue
        cup = node.get("cup")
        if isinstance(cup, dict) and cup.get("id") not in (None, cup_id):
            continue
        sched_map: dict[str, tuple[int, str]] = {}
        for s in schedules:
            if not isinstance(s, dict):
                continue
            sid, date = s.get("id"), s.get("date")
            idx = _to_int(s.get("index"))
            if idx is None:
                idx = _to_int(s.get("day"))
            if not sid or not date or idx is None:
                continue
            sched_map[str(sid)] = (db_day_by_date.get(str(date), idx), str(date))
        out: dict[tuple[int, int], ManifestRace] = {}
        for r in races:
            if not isinstance(r, dict):
                continue
            sched = sched_map.get(str(r.get("scheduleId")))
            number = _to_int(r.get("number"))
            if sched is None or number is None:
                continue
            start_at = r.get("startAt")
            start_dt = (
                datetime.datetime.fromtimestamp(start_at, JST)
                if isinstance(start_at, (int, float)) and not isinstance(start_at, bool) and start_at > 0
                else None
            )
            out[(sched[0], number)] = ManifestRace(
                day=sched[0], race_no=number, date=sched[1], start_at=start_dt,
                cancelled=bool(r.get("cancel")),
            )
        if out:
            return out
    return None


# ---------------------------------------------------------------------------
# DB書き込み
# ---------------------------------------------------------------------------

RACE_UPSERT_SQL = """
INSERT INTO races (kaisai_date, jocd, keirinjo_name, race_no, syumoku, grade_kbn,
                   kyori, shukai, start_time, encp)
VALUES (?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(kaisai_date, jocd, race_no) DO UPDATE SET
    syumoku=COALESCE(races.syumoku, excluded.syumoku),
    grade_kbn=COALESCE(races.grade_kbn, excluded.grade_kbn),
    kyori=COALESCE(races.kyori, excluded.kyori),
    shukai=COALESCE(races.shukai, excluded.shukai),
    start_time=COALESCE(races.start_time, excluded.start_time),
    encp=COALESCE(races.encp, excluded.encp)
RETURNING id
"""

RACER_INSERT_SQL = """
INSERT INTO racers (snum, name, pref, class_rank, kyakushitsu,
                    heikin_tokuten, syouritu, rentairitu2, rentairitu3,
                    kimarite_nige_count, kimarite_makuri_count,
                    kimarite_sashi_count, kimarite_mark_count,
                    standing_count, home_lead_count, back_lead_count)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(snum) DO NOTHING
"""

# 列の並びは keirin_scraper.save_to_db の entries INSERT と揃えている（列を足したら両方直す）。
# at_* には発走後に取り直した出走表の値が入る。WINTICKETは出走表の成績欄をレースごとの
# 記録(records)として持っているため「そのレース時点の値」のはずだが、レース後の更新が
# 混ざらないことまでは未検証（バックテストでat_*を使う時は補修分に注意）。
ENTRY_INSERT_SQL = """
INSERT INTO entries (race_id, snum, car_num, line_group, line_position, pref,
                     pre_race_comment, gear_ratio,
                     at_heikin_tokuten, at_class_rank, at_kyakushitsu,
                     at_syouritu, at_rentairitu2, at_rentairitu3,
                     at_kimarite_nige_count, at_kimarite_makuri_count,
                     at_kimarite_sashi_count, at_kimarite_mark_count,
                     at_standing_count, at_home_lead_count, at_back_lead_count)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(race_id, car_num) DO NOTHING
"""

RESULT_UPSERT_SQL = """
INSERT INTO results (race_id, snum, car_num, finish_pos, kimarite, agari_time)
VALUES (?,?,?,?,?,?)
ON CONFLICT(race_id, car_num) DO UPDATE SET
    finish_pos=excluded.finish_pos, kimarite=excluded.kimarite,
    agari_time=excluded.agari_time
"""

INTERVIEW_INSERT_SQL = """
INSERT INTO racer_interviews (race_id, snum, question, answer)
VALUES (?,?,?,?)
ON CONFLICT(race_id, snum, question) DO NOTHING
"""

# 同じ組み合わせの行が無い時だけ入れる（一意インデックスidx_odds_uniqueがあるので、
# 万一すり抜けてもbatchごと失敗するだけで重複は入らない）。同一batch（=同一トランザクション）内でも
# 先に入れた行が見えるので、同着で同じ組み合わせが2回来ても1行になる。
# INSERT ... SELECT のNULL・数値がtext扱いにならないよう型を明示している。
ODDS_INSERT_SQL = """
INSERT INTO odds (race_id, bet_type, combination, odds_value, ninki)
SELECT CAST(? AS INTEGER), ?, ?, CAST(? AS REAL), CAST(? AS INTEGER)
WHERE NOT EXISTS (
    SELECT 1 FROM odds WHERE race_id = ? AND bet_type = ? AND combination = ?
)
"""


def _result_statements(race_id: int, results: list[dict[str, Any]]) -> list[tuple[str, list]]:
    return [
        (RESULT_UPSERT_SQL,
         [race_id, r["snum"], r["car_num"], r["finish_pos"], r["kimarite"], r.get("agari_time")])
        for r in results
    ]


def _odds_statements(race_id: int, odds: list[dict[str, Any]]) -> list[tuple[str, list]]:
    return [
        (ODDS_INSERT_SQL,
         [race_id, o["bet_type"], o["combination"], o["odds_value"], o.get("ninki"),
          race_id, o["bet_type"], o["combination"]])
        for o in odds
    ]


def save_results_only(race_id: int, results: list[dict[str, Any]], odds: list[dict[str, Any]]) -> None:
    """結果だけの補修。sync_results_only.pyと同じく results/odds 以外は触らない。"""
    statements = _result_statements(race_id, results) + _odds_statements(race_id, odds)
    if not statements:
        return
    client = get_client()
    try:
        client.batch(statements)
    finally:
        client.close()


def save_full_race(race: RaceData) -> None:
    """出走表から取り直したレースを保存する。既存行は上書きしない（モジュールdocstring参照）。"""
    client = get_client()
    try:
        race_id = client.execute(
            RACE_UPSERT_SQL,
            [race.kaisai_date, race.jocd, race.keirinjo_name, race.race_no, race.syumoku,
             race.grade_kbn, race.kyori, race.shukai, race.start_time, race.encp],
        ).rows[0][0]

        statements: list[tuple[str, list]] = []
        cars: set[int] = set()
        snums: set[str] = set()
        for e in race.entries:
            cars.add(e["car_num"])
            snums.add(e["snum"])
            statements.append((
                RACER_INSERT_SQL,
                # racers.name はNOT NULL。名前が読めなかった選手で1レースまるごと保存に
                # 失敗しないよう、無ければsnumを仮の名前にする（次の通常同期で上書きされる）。
                [e["snum"], e.get("name") or e["snum"], e.get("pref"), e.get("class_rank"),
                 e.get("kyakushitsu"), e.get("heikin_tokuten"), e.get("syouritu"),
                 e.get("rentairitu2"), e.get("rentairitu3"),
                 e.get("kimarite_nige_count"), e.get("kimarite_makuri_count"),
                 e.get("kimarite_sashi_count"), e.get("kimarite_mark_count"),
                 e.get("standing_count"), e.get("home_lead_count"), e.get("back_lead_count")],
            ))
            statements.append((
                ENTRY_INSERT_SQL,
                [race_id, e["snum"], e["car_num"], e.get("line_group"), e.get("line_position"),
                 e.get("pref"), e.get("pre_race_comment"), e.get("gear_ratio"),
                 e.get("heikin_tokuten"), e.get("class_rank"), e.get("kyakushitsu"),
                 e.get("syouritu"), e.get("rentairitu2"), e.get("rentairitu3"),
                 e.get("kimarite_nige_count"), e.get("kimarite_makuri_count"),
                 e.get("kimarite_sashi_count"), e.get("kimarite_mark_count"),
                 e.get("standing_count"), e.get("home_lead_count"), e.get("back_lead_count")],
            ))
        # results/racer_interviews の snum は racers への外部キー。出走表に無い車番・選手が
        # 1件でも混ざると batch（1トランザクション）ごと失敗するため、出走表にある分だけ書く。
        statements += _result_statements(race_id, [r for r in race.results if r["car_num"] in cars])
        for iv in race.interviews:
            if iv.get("snum") in snums:
                statements.append((INTERVIEW_INSERT_SQL,
                                   [race_id, iv["snum"], iv.get("question"), iv["answer"]]))
        statements += _odds_statements(race_id, race.odds)
        client.batch(statements)
    finally:
        client.close()


# ---------------------------------------------------------------------------
# 補修処理
# ---------------------------------------------------------------------------

def _url(slug: str, page: str, cup_id: str, day: int, race_no: int) -> str:
    return f"https://winticket.jp/keirin/{slug}/{page}/{cup_id}/{day}/{race_no}"


def _top3_count(results: list[dict[str, Any]]) -> int:
    return sum(1 for r in results if r.get("finish_pos") is not None and 1 <= r["finish_pos"] <= 3)


def _has_sanrentan(odds: list[dict[str, Any]]) -> bool:
    return any(o.get("bet_type") == SANRENTAN for o in odds)


def _classify(results: list[dict[str, Any]], odds: list[dict[str, Any]],
              had_top3: int = 0, had_odds: bool = False) -> tuple[str, str]:
    top3 = max(_top3_count(results), had_top3)
    odds_ok = _has_sanrentan(odds) or had_odds
    if top3 >= 3 and odds_ok:
        return "repaired", ""
    if 0 < top3 < 3:
        # 落車・失格などでWINTICKET側にも3着までの着順が無い（3連単も不成立）。
        # 取り直しても増えないので未補修とは分けて報告する。
        return "source_incomplete", f"WINTICKET側の着順が{top3}件のみ"
    if top3 >= 3:
        # 3着まで揃っているのに3連単の払戻が読めないのは通常ありえない（解析失敗を疑う）
        return "failed", "着順はあるが3連単の払戻が読めない"
    return "failed", "結果ページに着順が無い（未反映か解析失敗）"


def repair_full(
    slug: str, cup_id: str, day: int, race_no: int, ctx: RunContext,
    fallback_name: str = "", card_html: str | None = None,
) -> tuple[str, str]:
    """出走表（＋発走済みなら結果）を取り直して保存する。戻り値は(outcome, detail)。"""
    if card_html is None:
        status, card_html = _fetch(_url(slug, "racecard", cup_id, day, race_no))
        if status != 200:
            return "failed", _status_detail("出走表", status)
    race = parse_racecard(card_html, cup_id, day, race_no)
    if race is None or not race.entries:
        return "failed", "出走表を解析できない"
    if not race.keirinjo_name:
        race.keirinjo_name = fallback_name
    race.interviews = parse_interviews(card_html)
    cancelled = parse_race_cancelled(card_html, race.kaisai_date, race.jocd, race.race_no)

    due = _is_due(_race_start(race.kaisai_date, race.start_time), race.kaisai_date, ctx)
    result_status: int | None = None
    if not cancelled and due:
        result_status, result_html = _fetch(_url(slug, "raceresult", cup_id, day, race_no))
        if result_status == 200:
            parse_raceresult(result_html, race)
            if cancelled is None:
                cancelled = parse_race_cancelled(result_html, race.kaisai_date, race.jocd, race.race_no)

    if not ctx.dry_run:
        # 中止レースや結果が取れなかったレースも、出走表は実在するので保存しておく
        # （結果は次回以降の(a)の検出で取り直す）。
        save_full_race(race)
    saved_note = "" if ctx.dry_run else "（出走表は保存）"
    if cancelled:
        return "cancelled", "中止"
    if not due:
        # 呼び出し側は発走済みのレースしか渡さないが、出走表の発走時刻が後ろにずれていた場合
        return ("would_repair" if ctx.dry_run else "repaired"), "発走前のため出走表のみ"
    if result_status != 200:
        return "failed", _status_detail("結果ページ", result_status or 0) + saved_note
    outcome, detail = _classify(race.results, race.odds)
    if outcome == "repaired" and ctx.dry_run:
        return "would_repair", ""
    return outcome, (detail + saved_note) if outcome == "failed" else detail


def safe_repair_full(*args: Any, **kwargs: Any) -> tuple[str, str]:
    """repair_full のDBエラー等を1レースの失敗として扱い、同じ開催の残りの補修を続ける。"""
    try:
        return repair_full(*args, **kwargs)
    except Exception as exc:  # noqa: BLE001
        return "failed", f"例外: {exc}"


def repair_results(race: DbRace, slug: str, entries_by_car: dict[int, str], ctx: RunContext) -> tuple[str, str]:
    """(a) 着順・払戻の欠け: 結果ページだけ取り直して results/odds を書く。"""
    status, html = _fetch(_url(slug, "raceresult", race.cup_id, race.day, race.race_no))
    if status != 200:
        return "failed", _status_detail("結果ページ", status)
    if parse_race_cancelled(html, race.kaisai_date, race.jocd, race.race_no):
        return "cancelled", "中止"

    data = RaceData(kaisai_date=race.kaisai_date, jocd=race.jocd, keirinjo_name=race.keirinjo_name,
                    race_no=race.race_no, encp=race.encp)
    data.entries = [{"car_num": car, "snum": snum} for car, snum in entries_by_car.items()]
    parse_raceresult(html, data)

    if any(r["car_num"] not in entries_by_car for r in data.results):
        # 出走表に無い車番の着順がある＝entriesが部分的にしか入っていない。results.snumは
        # racersへの外部キーなので、このまま書くと保存ごと失敗する。出走表から取り直す。
        return repair_full(slug, race.cup_id, race.day, race.race_no, ctx, race.keirinjo_name)

    outcome, detail = _classify(data.results, data.odds, race.n_top3, race.has_sanrentan)
    if outcome == "failed" and not data.results and not data.odds:
        return outcome, detail  # 書くものが無い
    if ctx.dry_run:
        return ("would_repair" if outcome == "repaired" else outcome), detail
    save_results_only(race.id, data.results, data.odds)
    return outcome, detail


# ---------------------------------------------------------------------------
# 開催単位の検証
# ---------------------------------------------------------------------------

@dataclass
class Cup:
    cup_id: str
    jocd: str
    keirinjo_name: str = ""
    races: dict[tuple[int, int], DbRace] = field(default_factory=dict)

    @property
    def start_str(self) -> str:
        return self.cup_id[:8]

    def day_dates(self) -> dict[int, str]:
        return {d: r.kaisai_date for (d, _), r in self.races.items()}

    def day_by_date(self) -> dict[str, int]:
        return {r.kaisai_date: d for (d, _), r in self.races.items()}

    def last_date(self) -> str:
        return max(r.kaisai_date for r in self.races.values())


def suspect_reasons(cup: Cup, since_str: str, today_str: str) -> list[str]:
    """DB上の形だけで分かる「欠けていそうな」開催の理由。空なら形の上では問題なし。
    実際に欠けているかは開催のレース一覧（マニフェスト）で確かめる。"""
    reasons: list[str] = []
    by_day: dict[int, list[int]] = {}
    for (day, race_no) in cup.races:
        by_day.setdefault(day, []).append(race_no)
    dates = cup.day_dates()
    cup_max_race = max(max(v) for v in by_day.values())
    for day, nos in sorted(by_day.items()):
        if dates[day] < since_str:
            continue
        nos.sort()
        if nos != list(range(1, nos[-1] + 1)):
            reasons.append(f"{day}日目のレース番号が歯抜け")
        elif nos[-1] < cup_max_race:
            # 日の途中で取得が切れた（後半レースだけ無い）可能性
            reasons.append(f"{day}日目の最終Rが他の日より少ない")
    days = sorted(by_day)
    if days != list(range(1, days[-1] + 1)):
        reasons.append("日程が歯抜け")
    last_day = days[-1]
    if last_day < 3:
        # 開催は3日以上がほとんど。最終日の翌日が既に過ぎているのに2日目以前で
        # 終わっていれば、後ろの日程がまるごと欠けている可能性がある。
        try:
            next_date = (datetime.datetime.strptime(dates[last_day], "%Y%m%d")
                         + datetime.timedelta(days=1)).strftime("%Y%m%d")
        except ValueError:
            next_date = ""
        if next_date and since_str <= next_date < today_str:
            reasons.append(f"{last_day}日目で終わっている")
    return reasons


def walk_cup_without_manifest(
    cup_id: str, slug: str, cup: Cup | None, ctx: RunContext, report: Report,
    probe: tuple[int, int], probe_html: str,
) -> None:
    """マニフェストが読めなかった時の代替: scrape_cupと同じく1Rから404まで順に辿る。
    DBにあるレースは取りに行かない（確認用に取得済みの出走表は使い回す）。"""
    present = set(cup.races) if cup else set()
    name = cup.keirinjo_name if cup else ""
    for day in range(1, MAX_DAYS_PER_CUP + 1):
        day_had_race = False
        ended_cleanly = False
        for race_no in range(1, MAX_RACES_PER_DAY + 1):
            if (day, race_no) in present:
                day_had_race = True
                continue
            label = f"{name or slug} {cup_id} {day}日目 {race_no}R"
            if (day, race_no) == probe:
                status, html = 200, probe_html
            else:
                status, html = _fetch(_url(slug, "racecard", cup_id, day, race_no))
            if status == 404:
                ended_cleanly = True
                break
            if status != 200:
                report.add(GapResult("missing", "failed", label, cup_id[:8], _status_detail("出走表", status)))
                break
            race = parse_racecard(html, cup_id, day, race_no)
            if race is None or not race.entries:
                report.add(GapResult("missing", "failed", label, cup_id[:8], "出走表を解析できない"))
                break
            day_had_race = True
            if race.kaisai_date < ctx.since_str:
                continue
            if race.kaisai_date > ctx.today_str or not _is_due(
                _race_start(race.kaisai_date, race.start_time), race.kaisai_date, ctx
            ):
                return  # ここから先はまだ走っていないレース（通常の同期の担当）
            label = f"{race.keirinjo_name or name} {race.kaisai_date} {race_no}R (wt:{cup_id}/{day}/{race_no})"
            outcome, detail = safe_repair_full(slug, cup_id, day, race_no, ctx, name, card_html=html)
            report.add(GapResult("missing", outcome, label, race.kaisai_date, detail))
        if not day_had_race and ended_cleanly:
            break  # 1レースも無い日＝開催の終わり


def verify_cup(
    cup_id: str, slug: str, cup: Cup | None, reasons: list[str],
    ctx: RunContext, report: Report, cancelled_encps: set[str],
) -> None:
    """開催のレース一覧（出走表ページ1枚に入っている）とDBを突き合わせ、DBに無い
    発走済みレースを取り直す。DBにあるが中止のレースは cancelled_encps に入れ、
    後段の結果取り直しで無駄に結果ページを見に行かないようにする。"""
    name = cup.keirinjo_name if cup else slug
    print(f"開催 {name} {cup_id} を確認（{'・'.join(reasons)}）")
    probe = min(cup.races) if cup else (1, 1)
    status, html = _fetch(_url(slug, "racecard", cup_id, probe[0], probe[1]))
    if status != 200:
        if cup is None:
            if status == 404:
                # 日程には載っているのに初日1Rの出走表が無い＝開催中止とみなす。未補修に
                # 数えると中止開催が期間内にある間ずっとジョブが失敗扱いになるため分ける。
                report.add(GapResult("missing", "cancelled", f"開催 {slug} {cup_id} 全体", cup_id[:8],
                                     "初日1Rの出走表が404（開催中止とみなす）"))
            else:
                report.add(GapResult("missing", "failed", f"開催 {slug} {cup_id} 全体", cup_id[:8],
                                     _status_detail("出走表", status)))
        report.cup_checked(False, f"{name} {cup_id}（{_status_detail('出走表', status)}）")
        return

    if cup is None:
        # DBに1レースも無い開催は場名が分からないので、取得した出走表から読む（ログ用）
        probe_race = parse_racecard(html, cup_id, probe[0], probe[1])
        if probe_race is not None and probe_race.keirinjo_name:
            name = probe_race.keirinjo_name
    manifest = parse_cup_manifest(html, cup_id, cup.day_by_date() if cup else {})
    if manifest is None:
        report.cup_checked(False, f"{name} {cup_id}（レース一覧を解析できず、1Rから辿って確認）")
        walk_cup_without_manifest(cup_id, slug, cup, ctx, report, probe, html)
        return
    report.cup_checked(True, f"{name} {cup_id}")

    present = cup.races if cup else {}
    for key in sorted(manifest):
        m = manifest[key]
        if key in present:
            if m.cancelled:
                cancelled_encps.add(present[key].encp)
            continue
        if m.date < ctx.since_str or m.date > ctx.today_str:
            continue
        if not _is_due(m.start_at, m.date, ctx):
            continue  # まだ走っていないレースは通常の同期（daily-sync）の担当
        label = f"{name} {m.date} {m.race_no}R (wt:{cup_id}/{m.day}/{m.race_no})"
        if m.cancelled:
            report.add(GapResult("missing", "cancelled", label, m.date, "中止"))
            continue
        outcome, detail = safe_repair_full(
            slug, cup_id, m.day, m.race_no, ctx, cup.keirinjo_name if cup else "",
            card_html=html if key == probe else None,
        )
        report.add(GapResult("missing", outcome, label, m.date, detail))


# ---------------------------------------------------------------------------
# 計画・集計・main
# ---------------------------------------------------------------------------

def _rotation_slot(now: datetime.datetime, slices: int) -> int:
    # 半日ごとに次の分割へ進む（1日2回の実行で順番に一巡する）。GitHubの起動遅延で
    # 2回が同じ半日に入っても、その回は同じ分割を見るだけで抜けは起きない。
    return (now.date().toordinal() * 2 + (1 if now.hour >= 12 else 0)) % slices


def _rotation_bucket(cup_id: str, slices: int) -> int:
    # int(cup_id) % slices だと cup_id = 初日×100 + 場コード のため、4や5で割ると
    # 場コードだけで分かれてしまい偏る。安定したハッシュで散らす（hash()は実行ごとに変わる）。
    return zlib.crc32(cup_id.encode()) % slices


def _slug_for(cup_id: str, jocd: str, cup_venues: dict[str, str]) -> str | None:
    return cup_venues.get(cup_id) or JOCD_TO_WINTICKET_SLUG.get(jocd)


def write_summary(report: Report, ctx: RunContext, plan_lines: list[str], fail_before: str) -> int:
    counts: dict[str, dict[str, int]] = {c: {o: 0 for o in OUTCOME_ORDER} for c in CATEGORY_LABELS}
    for item in report.items:
        counts[item.category][item.outcome] += 1
    failed = [i for i in report.items if i.outcome == "failed"]
    old_failed = [i for i in failed if i.kaisai_date < fail_before]

    lines = [
        "## データ欠損の補修（repair_gaps.py）",
        "",
        f"対象: {ctx.since_str}〜{ctx.today_str}（発走+{DUE_MARGIN_MIN}分経過分）"
        + ("　**dry-run（DB書き込みなし）**" if ctx.dry_run else ""),
        "",
        *plan_lines,
        f"- WINTICKETへのリクエスト: {_budget.used}件（上限{_budget.limit}）",
        f"- レース一覧で確認できた開催: {report.cups_verified}件"
        + (f" / 確認できなかった開催: {len(report.cups_unverified)}件" if report.cups_unverified else ""),
        "",
        "| 種別 | 検出 | " + " | ".join(OUTCOME_LABELS[o] for o in OUTCOME_ORDER) + " |",
        "|---|---:|" + "---:|" * len(OUTCOME_ORDER),
    ]
    for cat, label in CATEGORY_LABELS.items():
        total = sum(counts[cat].values())
        lines.append(f"| {label} | {total} | " + " | ".join(str(counts[cat][o]) for o in OUTCOME_ORDER) + " |")
    lines.append("")
    if failed:
        lines.append(f"### 未補修（{len(failed)}件。次回の実行で再試行）")
        for item in sorted(failed, key=lambda i: i.kaisai_date)[:50]:
            lines.append(f"- {CATEGORY_LABELS[item.category]}: {item.label} … {item.detail}")
        if len(failed) > 50:
            lines.append(f"- ほか{len(failed) - 50}件")
        lines.append("")
    if report.cups_unverified:
        lines.append("### レース一覧で確認できなかった開催")
        lines.extend(f"- {c}" for c in report.cups_unverified[:30])
        lines.append("")
    others = [i for i in report.items if i.outcome in ("cancelled", "source_incomplete")]
    if others:
        lines.append("### 取り直しても埋まらない欠け（中止・落車等）")
        for item in sorted(others, key=lambda i: i.kaisai_date)[:30]:
            lines.append(f"- {OUTCOME_LABELS[item.outcome]}: {item.label} … {item.detail}")
        lines.append("")

    text = "\n".join(lines)
    print("\n" + text)
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as f:
            f.write(text + "\n")
    if old_failed:
        print(f"\n{fail_before}より前の欠損が{len(old_failed)}件補修できずに残っているため終了コード1にする")
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="直近のデータ欠損を検出してWINTICKETから取り直す")
    parser.add_argument("--days", type=int, default=DEFAULT_DAYS, help=f"何日前まで見るか（既定{DEFAULT_DAYS}）")
    parser.add_argument("--dry-run", action="store_true", help="検出と確認だけ行いDBに書かない（HTTPは送る）")
    parser.add_argument("--sweep-all", action="store_true", help="巡回を待たず期間内の全開催をレース一覧と突き合わせる")
    parser.add_argument("--sweep-slices", type=int, default=DEFAULT_SWEEP_SLICES,
                        help=f"巡回の分割数（既定{DEFAULT_SWEEP_SLICES}。1回の実行でこの分の1を確認）")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS, help=f"同時処理数（既定{DEFAULT_WORKERS}）")
    parser.add_argument("--max-requests", type=int, default=DEFAULT_MAX_REQUESTS,
                        help=f"WINTICKETへのリクエスト上限（既定{DEFAULT_MAX_REQUESTS}）")
    parser.add_argument("--fail-after-days", type=int, default=DEFAULT_FAIL_AFTER_DAYS,
                        help=f"この日数より古い欠損が残ったら終了コード1（既定{DEFAULT_FAIL_AFTER_DAYS}）")
    args = parser.parse_args()

    global _budget
    _budget = _RequestBudget(max(0, args.max_requests))

    now = datetime.datetime.now(JST)
    today = now.date()
    since = today - datetime.timedelta(days=args.days)
    ctx = RunContext(now=now, since_str=since.strftime("%Y%m%d"), today_str=today.strftime("%Y%m%d"),
                     dry_run=args.dry_run)
    yesterday_str = (today - datetime.timedelta(days=1)).strftime("%Y%m%d")
    fail_before = (today - datetime.timedelta(days=args.fail_after_days)).strftime("%Y%m%d")
    # 開催の形（何日目まであるか）を見るため、補修対象より開催の最大日数ぶん手前から読む
    scan_from = since - datetime.timedelta(days=CUP_LOOKBACK_DAYS)
    scan_from_str = scan_from.strftime("%Y%m%d")

    # --- 検出（DB問い合わせ2回） ---
    races = load_window_races(scan_from_str, ctx.today_str)
    cup_venues = load_cached_cup_venues(scan_from.strftime("%Y%m"))

    cups: dict[str, Cup] = {}
    for r in races:
        cup = cups.setdefault(r.cup_id, Cup(cup_id=r.cup_id, jocd=r.jocd, keirinjo_name=r.keirinjo_name))
        cup.races[(r.day, r.race_no)] = r
        if not cup.keirinjo_name:
            cup.keirinjo_name = r.keirinjo_name

    due_races = [
        r for r in races
        if r.kaisai_date >= ctx.since_str and _is_due(_race_start(r.kaisai_date, r.start_time), r.kaisai_date, ctx)
    ]
    # 中止と記録済みのレース（races.cancelled）は着順が永久に入らないので欠損扱いしない
    entries_gaps = [r for r in due_races if r.n_entries == 0 and not r.cancelled]
    results_gaps = [r for r in due_races
                    if r.n_entries > 0 and not r.cancelled and (r.n_top3 < 3 or not r.has_sanrentan)]

    slices = max(1, args.sweep_slices)
    slot = _rotation_slot(now, slices)
    to_verify: list[tuple[str, Cup | None, list[str]]] = []
    reason_counts = {"suspect": 0, "recent": 0, "sweep": 0, "absent": 0}
    for cup_id, cup in sorted(cups.items()):
        if cup.start_str < scan_from_str:
            continue  # 期間より前に始まった開催は、残りの日程も期間に届かない
        if not any(_is_due(_race_start(r.kaisai_date, r.start_time), r.kaisai_date, ctx)
                   for r in cup.races.values()):
            continue  # まだ1レースも走っていない開催は確かめるものが無い
        reasons = suspect_reasons(cup, ctx.since_str, ctx.today_str)
        if reasons:
            reason_counts["suspect"] += 1
        if cup.last_date() >= yesterday_str:
            reasons.append("直近")
            reason_counts["recent"] += 1
        if args.sweep_all or _rotation_bucket(cup_id, slices) == slot:
            reasons.append("全件確認" if args.sweep_all else "巡回")
            reason_counts["sweep"] += 1
        if reasons:
            to_verify.append((cup_id, cup, reasons))
    if cup_venues is not None:
        for cup_id in sorted(cup_venues):
            start = cup_id[:8]
            if cup_id in cups or not (scan_from_str <= start <= ctx.today_str):
                continue
            # 初日の第1レースは早くても8時台。それより前に見ても何も走っていない
            if start == ctx.today_str and now.hour < 9:
                continue
            to_verify.append((cup_id, None, ["DBに1レースも無い"]))
            reason_counts["absent"] += 1

    plan_lines = [
        f"- DBの対象レース: {len(races)}件（うち発走+{DUE_MARGIN_MIN}分経過・期間内 {len(due_races)}件）",
        f"- 検出: 着順・払戻の欠け {len(results_gaps)}件 / 出走表の欠け {len(entries_gaps)}件",
        f"- レース一覧と突き合わせる開催: {len(to_verify)}件（形が怪しい {reason_counts['suspect']} / "
        f"直近 {reason_counts['recent']} / 巡回 {reason_counts['sweep']}（{slot + 1}/{slices}） / "
        f"DBに無い開催 {reason_counts['absent']}）"
        + ("" if cup_venues is not None else "　※日程キャッシュ未作成のためDBに無い開催は未確認"),
    ]
    print("\n".join(plan_lines))

    report = Report()
    workers = max(1, args.workers)
    cancelled_encps: set[str] = set()

    # --- 開催単位の確認（DBに無いレースの補修） ---
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = []
        for cup_id, cup, reasons in to_verify:
            slug = _slug_for(cup_id, cup.jocd if cup else cup_id[8:], cup_venues or {})
            if slug is None:
                report.cup_checked(False, f"{cup.keirinjo_name if cup else ''} {cup_id}（開催場スラッグ不明）")
                continue
            futures.append(executor.submit(verify_cup, cup_id, slug, cup, reasons, ctx, report, cancelled_encps))
        for future in concurrent.futures.as_completed(futures):
            try:
                future.result()
            except Exception as exc:  # noqa: BLE001 - 1開催の失敗で全体を止めない
                print(f"  警告: 開催の確認中に例外: {exc}")

    # --- レース単位の補修（出走表の欠け・着順/払戻の欠け） ---
    entries_by_race = load_entries_by_race([r.id for r in results_gaps if r.encp not in cancelled_encps])

    def run_race(category: str, race: DbRace) -> None:
        slug = _slug_for(race.cup_id, race.jocd, cup_venues or {})
        if slug is None:
            report.add(GapResult(category, "failed", race.label, race.kaisai_date, "開催場スラッグ不明"))
            return
        if race.encp in cancelled_encps:
            if not ctx.dry_run:
                mark_race_cancelled(race.encp)
            report.add(GapResult(category, "cancelled", race.label, race.kaisai_date, "中止（レース一覧で確認）"))
            return
        if category == "entries":
            outcome, detail = safe_repair_full(slug, race.cup_id, race.day, race.race_no, ctx, race.keirinjo_name)
        else:
            try:
                outcome, detail = repair_results(race, slug, entries_by_race.get(race.id, {}), ctx)
            except Exception as exc:  # noqa: BLE001 - 1レースの失敗（DBエラー等）で残りを止めない
                outcome, detail = "failed", f"例外: {exc}"
        if outcome == "cancelled" and not ctx.dry_run:
            # 以後の通常同期・補修で「未完了」として取り直し続けないよう記録する
            mark_race_cancelled(race.encp)
        report.add(GapResult(category, outcome, race.label, race.kaisai_date, detail))

    # 新しい日付から処理する（リクエスト上限に達した時、翌朝の前日サマリーに効く直近分を優先）
    race_tasks = [("entries", r) for r in entries_gaps] + [("results", r) for r in results_gaps]
    race_tasks.sort(key=lambda t: (t[1].kaisai_date, t[1].start_time or ""), reverse=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        for future in [executor.submit(run_race, cat, r) for cat, r in race_tasks]:
            future.result()

    return write_summary(report, ctx, plan_lines, fail_before)


if __name__ == "__main__":
    sys.exit(main())
