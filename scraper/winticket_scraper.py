"""WINTICKET（公式ネット投票サイト）から過去レースの出走表・結果・払戻を取得する。

KEIRIN.JP（keirin_scraper.py）は「本日/明日」のライブ発売中レースしか
出走表・結果を取得できる入口がなく、過去日程のバックテスト用データが作れない。
WINTICKETは過去日程の出走表・結果ページが素のHTTP GETだけで取得でき
（Playwright不要）、日付を跨いだ遡り取得に向いているためこちらを使う。

出走表: https://winticket.jp/keirin/{venue}/racecard/{cupId}/{day}/{raceNo}
結果:   https://winticket.jp/keirin/{venue}/raceresult/{cupId}/{day}/{raceNo}
月間開催日程: https://winticket.jp/keirin/{venue}/schedule/{YYYYMM}
cupId = 開催初日(YYYYMMDD) + 開催場コード(2桁、KEIRIN.JPのjocdと共通)

DB保存はkeirin_scraper.pyのRaceData/save_to_dbをそのまま流用する
（スキーマはデータ取得元に依存しないため）。選手の識別キー(snum)は
KEIRIN.JP側の選手登録番号と体系が異なる可能性があるため、
衝突を避けて "wt" + WINTICKETのcyclist IDを充てる。

個人利用・低頻度実行を前提とする。節度あるアクセス間隔を必ず空けること。
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime
import json
import re
import threading
import time
from typing import Any

import requests
from bs4 import BeautifulSoup, Tag

from db import get_client
from keirin_scraper import RaceData, RacerHistoryEntry, save_to_db, resolve_full_date

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "keirin-prediction-app/0.1 (personal use, non-commercial backtest tool)"
)
# WINTICKETへのアクセス間隔は「全スレッド合計で、リクエスト開始の間隔を最低この秒数
# 空ける」形で守る（以前は各スレッドが取得のたびに1.5秒寝ていたため、スレッド数を
# 増やすほど全体の頻度が上がり、逆にスレッドが少ないと待ち時間が無駄になっていた）。
# 0.4秒＝全体で最大2.5リクエスト/秒。
GLOBAL_MIN_REQUEST_INTERVAL_SEC = 0.4

# 旧来の「1回ごとの待機」。間隔はGLOBAL_MIN_REQUEST_INTERVAL_SECで_get内で一元管理する
# ようにしたため0（_sleep()は各backfillスクリプトからimportされているので関数は残す）。
REQUEST_INTERVAL_SEC = 0.0

# WINTICKETは winticket.jp → www.winticket.jp に毎回301リダイレクトしていた（1リクエスト
# ごとに余計な往復＋別ホストへの接続）。最初からwwwに向ける。
WINTICKET_BASE = "https://www.winticket.jp"

# --all-venuesで同時に処理する開催場数（＝同時に処理中のリクエスト数の上限）。
# 2026-10に8へ上げたところ、開始直後に8開催場が同時に日程ページを取りに行った
# 瞬間にWINTICKETから429（リクエスト過多）が14件返ったため5に戻した（5では0件）。
# 現在は上のGLOBAL_MIN_REQUEST_INTERVAL_SECで開始間隔も空けるため同時発射は起きない。
VENUE_CONCURRENCY = 5

# 開催(cup)は3〜4日、GIなど大きい開催では6日程度続く。cup_idの先頭8桁は
# 「開催初日」なので、取得対象を初日だけで判定すると対象期間より前に始まった
# 開催の後半日程が丸ごと落ちる。cupを選ぶ窓だけこの日数ぶん手前まで広げる。
CUP_LOOKBACK_DAYS = 7

# 一時的な失敗（5xx・通信エラー）をリトライする回数。リトライしないと1回の失敗で
# その日のレースが途中打ち止めになり、取得済み分だけがDBに残る。その状態は
# load_completed_days から「その日は取得完了」と見えてしまうため、結果が永久に
# 欠ける原因になる。
HTTP_MAX_RETRIES = 3
HTTP_RETRY_DELAY_SEC = 2.0

# scrape_one_race の戻り値を区別するための番兵。404（そのレース番号は存在しない
# ＝その日の打ち止め）と、一時的な取得失敗を同じNoneで返すと、失敗を打ち止めと
# 誤認して以降のレース・以降の日程を丸ごと捨ててしまう。
RACE_NOT_FOUND = object()


def _sleep() -> None:
    time.sleep(REQUEST_INTERVAL_SEC)


_thread_local = threading.local()
_throttle_lock = threading.Lock()
_next_request_at = 0.0


def _session() -> requests.Session:
    """スレッドごとに1つの接続を使い回す（keep-alive＋gzip）。以前はurllibで毎回
    新しいTCP/TLS接続を張り、圧縮なしで全文を受け取っていたため、GitHub Actions
    （米国）から1ページ数秒かかっていた。requests.Sessionはスレッド間で共有しない。"""
    session = getattr(_thread_local, "session", None)
    if session is None:
        session = requests.Session()
        session.headers.update({"User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate"})
        _thread_local.session = session
    return session


def _throttle() -> None:
    """全スレッド合計で、リクエスト開始の間隔をGLOBAL_MIN_REQUEST_INTERVAL_SEC以上空ける。"""
    global _next_request_at
    with _throttle_lock:
        now = time.monotonic()
        start_at = max(now, _next_request_at)
        _next_request_at = start_at + GLOBAL_MIN_REQUEST_INTERVAL_SEC
    wait = start_at - now
    if wait > 0:
        time.sleep(wait)


def _get(url: str) -> tuple[int, str]:
    """URLを取得して (status, body) を返す。

    4xxは再試行しても変わらないので即座に返す（404はレース不存在の判定に使う）。
    ただし429（リクエスト過多）と5xx・ネットワーク由来の一時的な失敗は
    HTTP_MAX_RETRIES回まで再試行する。
    再試行し切っても失敗した場合はstatusに最後のコード（通信エラーなら0）を返す。
    """
    url = url.replace("https://winticket.jp/", f"{WINTICKET_BASE}/")
    session = _session()
    last_status = 0
    for attempt in range(HTTP_MAX_RETRIES + 1):
        _throttle()
        try:
            resp = session.get(url, timeout=(10, 20))
            status = resp.status_code
            if status == 200:
                # requestsの文字コード推測は使わず、従来どおりUTF-8で読む
                return status, resp.content.decode("utf-8", errors="replace")
            if status == 429:
                # リクエスト過多。即座に諦めると開催場ごと未取得になるため、
                # Retry-After（無ければ段階的に長く）待ってから再試行する。
                last_status = status
                if attempt < HTTP_MAX_RETRIES:
                    retry_after = resp.headers.get("Retry-After")
                    wait = float(retry_after) if retry_after and retry_after.isdigit() else 10.0 * (attempt + 1)
                    time.sleep(wait)
                continue
            if status < 500:
                return status, ""
            last_status = status
        except requests.RequestException as e:
            # 以前はここで例外が伝播して実行全体が落ちていた。逐次保存しているので
            # 取得済み分は残るが、残りの開催場が全て未処理になるため捕まえる。
            print(f"  警告: 通信エラー {e} ({url})")
            last_status = 0
        if attempt < HTTP_MAX_RETRIES:
            time.sleep(HTTP_RETRY_DELAY_SEC * (attempt + 1))
    print(f"  警告: {HTTP_MAX_RETRIES}回再試行しても取得できず status={last_status} ({url})")
    return last_status, ""


_LINE_POSITION_NAMES = ["先頭", "番手", "3番手", "4番手", "5番手", "6番手", "7番手"]

HEADING_RE = re.compile(
    r"(?P<race_no>\d+)\s*R\s+.*?"
    r"(?P<grade>GP|G1|G2|G3|F1|F2)\s+"
    r"(?P<syumoku>.+?)\s+"
    r"発走\s*(?P<start_time>\d{1,2}:\d{2})\s+"
    r"締切\s*\d{1,2}:\d{2}\s+"
    r"(?P<year>\d{4})年(?P<month>\d{1,2})月(?P<day>\d{1,2})日\s+"
    r"(?P<kyori>[\d,]+)m\s*\((?P<shukai>\d+)周\)"
)
NAME_INFO_RE = re.compile(r"(SS|S1|S2|A1|A2|A3|L1|L2|L3)\s*(\d+)歳\s*(\d+)期")
CYCLIST_ID_RE = re.compile(r"/keirin/cyclist/(\d+)")
BIB_NUM_RE = re.compile(r"(\d+)番")
CLASS_TEXT_RE = re.compile(r"^([A-Z]+)級(\d+)班$")

RACER_HISTORY_MAX_AGE_DAYS = 3
# 「直近8走」の成績は選手が実際にレースに出た時しか変わらない（毎日ではない）。
# =1だと1日2回実行のたびに実質ほぼ全選手が再取得対象になり、特に朝の実行
# （その日初めて見る出走選手が多い）でプロフィールページの個別取得が積み重なり
# 大幅に遅くなっていた（実測: 朝1400件補完/約35分 vs 夕0件補完/約26分）。
# 3日に緩めることで大半の選手が複数回の実行をまたいでキャッシュヒットするようになる。


def _convert_class_text(text: str) -> str | None:
    """選手プロフィールページの級班表記（例: "A級2班"）をracersテーブルの
    形式（例: "A2"）に変換する。"""
    m = CLASS_TEXT_RE.match(text.strip())
    if not m:
        return None
    return f"{m.group(1)}{m.group(2)}"


def _age_in_days(timestamp: str | None) -> float | None:
    if not timestamp:
        return None
    updated = datetime.datetime.fromisoformat(timestamp)
    return (datetime.datetime.now() - updated).total_seconds() / 86400


def _days_since_update(query: str, params: tuple) -> float | None:
    client = get_client()
    try:
        result = client.execute(query, list(params))
    finally:
        client.close()
    if not result.rows:
        return None
    return _age_in_days(result.rows[0][0])


def scrape_cyclist_history(cyclist_id: str) -> tuple[str | None, list[RacerHistoryEntry]]:
    """選手プロフィールページ(/keirin/cyclist/{id})から前期級班と直近の
    出走履歴（開催日・開催場略称・その開催内の各レース着順）を取得する。
    """
    status, html = _get(f"https://winticket.jp/keirin/cyclist/{cyclist_id}")
    _sleep()
    if status != 200:
        return None, []
    soup = BeautifulSoup(html, "html.parser")

    prev_class_rank: str | None = None
    dt = soup.find("dt", string="級班 (年月日)")
    if dt is not None:
        dd = dt.find_next_sibling("dd")
        if dd is not None:
            items = dd.find_all("li")
            # 先頭が現在の級班、2番目が前期の級班（新しい順に並んでいる）
            if len(items) >= 2:
                text = items[1].get_text(" ", strip=True)
                m = re.match(r"^(\S+)", text)
                if m:
                    prev_class_rank = _convert_class_text(m.group(1))

    snum = "wt" + cyclist_id
    anchor = datetime.date.today()
    histories: list[RacerHistoryEntry] = []
    outer_list = soup.find("ul", class_=re.compile(r"^List___Wrapper"))
    if outer_list is not None:
        for child in outer_list.find_all(recursive=False):
            time_tag = child.find(class_=re.compile(r"^LatestCupResultListItem___Date"))
            venue_a = child.find("a", href=re.compile(r"/racecard/"))
            if time_tag is None or venue_a is None:
                continue
            race_date = time_tag.get_text(strip=True)
            venue_abbr = venue_a.get_text(strip=True)
            orders = child.find_all(class_=re.compile(r"^PastRaceOrder___Order"))
            order_texts = [o.get_text(strip=True) for o in orders]
            # サイト側のDOMがなぜか全項目を2回ずつ描画しているため前半だけ使う
            order_texts = order_texts[: len(order_texts) // 2]
            if not race_date or not order_texts:
                continue
            race_date_full = resolve_full_date(race_date, anchor)
            if race_date_full is None:
                continue  # 想定外の日付表記は日付フィルタが効かせられないためスキップする
            histories.append(RacerHistoryEntry(
                snum=snum,
                race_date=race_date,
                race_date_full=race_date_full,
                venue_abbr=venue_abbr,
                finish_positions=",".join(order_texts),
            ))
    return prev_class_rank, histories


def enrich_entries_with_history(entries: list[dict[str, Any]]) -> list[RacerHistoryEntry]:
    """出走表の各選手について、前期級班・直近成績が未取得/古い場合だけ
    プロフィールページを取得して補完する（節度あるアクセスのため選手単位で
    鮮度をキャッシュする）。entriesのprev_class_rankはその場で書き換える。
    """
    all_histories: list[RacerHistoryEntry] = []
    targets = [
        e for e in entries
        if e.get("snum") and str(e["snum"]).startswith("wt") and "unknown" not in str(e["snum"])
    ]
    if not targets:
        return all_histories

    # 鮮度チェックをレース単位の1クエリにまとめる（以前は選手ごとに1往復×7〜9人）。
    snums = [str(e["snum"]) for e in targets]
    client = get_client()
    try:
        rows = client.execute(
            f"""SELECT s.snum,
                   (SELECT updated_at FROM racers WHERE snum = s.snum AND prev_class_rank IS NOT NULL),
                   (SELECT MAX(scraped_at) FROM racer_race_history WHERE snum = s.snum)
                FROM (VALUES {",".join("(?)" for _ in snums)}) AS s(snum)""",
            snums,
        ).rows
    finally:
        client.close()
    freshness = {str(r[0]): (r[1], r[2]) for r in rows}

    for entry in targets:
        snum = str(entry["snum"])
        cyclist_id = snum[2:]
        class_updated_at, history_updated_at = freshness.get(snum, (None, None))

        need_class = class_updated_at is None
        history_age = _age_in_days(history_updated_at)
        need_history = history_age is None or history_age > RACER_HISTORY_MAX_AGE_DAYS
        if not need_class and not need_history:
            continue

        prev_class_rank, histories = scrape_cyclist_history(cyclist_id)
        if need_class and prev_class_rank is not None:
            entry["prev_class_rank"] = prev_class_rank
        if need_history:
            all_histories.extend(histories)
    return all_histories


# 月間日程ページ（開催場×月）のキャッシュ。日程は月単位で先まで公開されていて1日の
# 中ではまず変わらないのに、毎回の同期で約55ページ（全リクエストの約半分）を取り直して
# いた。JSTの日付が変わって最初の同期でだけ取り直し、それ以外はDBのキャッシュを使う。
# 取得に失敗した時は古いキャッシュで代用し（取得日は更新しないので次回また取りに行く）、
# キャッシュも無ければ従来どおり空扱い＋警告。
_schedule_cache: dict[tuple[str, str], tuple[list[str], str]] = {}
_schedule_cache_lock = threading.Lock()
FORCE_SCHEDULE_REFRESH = False


def _today_jst_str() -> str:
    return datetime.datetime.now(JST).strftime("%Y%m%d")


def load_schedule_cache() -> None:
    client = get_client()
    try:
        client.execute(
            """CREATE TABLE IF NOT EXISTS wt_schedule_cache (
                   venue      TEXT NOT NULL,
                   yyyymm     TEXT NOT NULL,
                   cup_ids    TEXT NOT NULL,
                   fetched_on TEXT NOT NULL,
                   PRIMARY KEY (venue, yyyymm)
               )"""
        )
        rows = client.execute("SELECT venue, yyyymm, cup_ids, fetched_on FROM wt_schedule_cache").rows
    finally:
        client.close()
    with _schedule_cache_lock:
        for venue, yyyymm, cup_ids, fetched_on in rows:
            _schedule_cache[(str(venue), str(yyyymm))] = (json.loads(cup_ids), str(fetched_on))


def discover_cup_ids(venue: str, yyyymm: str) -> list[str]:
    """開催場の月間日程ページから、その月に実際に開催された開催ID(cupId)一覧を返す。"""
    today = _today_jst_str()
    with _schedule_cache_lock:
        cached = _schedule_cache.get((venue, yyyymm))
    if cached is not None and cached[1] == today and not FORCE_SCHEDULE_REFRESH:
        return cached[0]

    status, html = _get(f"https://winticket.jp/keirin/{venue}/schedule/{yyyymm}")
    _sleep()
    if status != 200:
        # 日程ページが取れないと、この開催場・この月は「開催が無かった」ことに
        # なって静かに丸ごと飛ぶ。気付けるよう必ず記録する。
        print(f"  警告: 日程ページ取得失敗 status={status} {venue}/{yyyymm}"
              + ("（前回のキャッシュで代用）" if cached is not None else ""))
        return cached[0] if cached is not None else []
    ids = sorted(set(re.findall(rf"/keirin/{venue}/racecard/(\d+)", html)))
    client = get_client()
    try:
        client.execute(
            """INSERT INTO wt_schedule_cache (venue, yyyymm, cup_ids, fetched_on) VALUES (?,?,?,?)
               ON CONFLICT (venue, yyyymm) DO UPDATE SET
                   cup_ids = excluded.cup_ids, fetched_on = excluded.fetched_on""",
            [venue, yyyymm, json.dumps(ids), today],
        )
    finally:
        client.close()
    with _schedule_cache_lock:
        _schedule_cache[(venue, yyyymm)] = (ids, today)
    return ids


def _find_by_class_prefix(soup: Tag, prefix: str) -> Tag | None:
    return soup.find(class_=re.compile(rf"^{re.escape(prefix)}"))


def _find_all_by_class_prefix(soup: Tag, prefix: str) -> list[Tag]:
    return soup.find_all(class_=re.compile(rf"^{re.escape(prefix)}"))


def parse_line_formation(soup: BeautifulSoup) -> dict[int, tuple[int, str]]:
    """並び予想から {車番: (ライングループ番号, 隊列内位置)} を返す。

    未提供のレース（並び予想なし）の場合は空dictを返す。
    """
    heading = soup.find(string="並び予想")
    if heading is None:
        return {}
    wrapper = heading.find_parent()
    if wrapper is None:
        return {}
    container = wrapper.find_parent()
    if container is None:
        return {}
    bib_group = _find_by_class_prefix(container, "BibGroup___Wrapper")
    if bib_group is None:
        return {}

    result: dict[int, tuple[int, str]] = {}
    line_group = 1
    position_in_line = 0
    for child in bib_group.find_all(recursive=False):
        classes = " ".join(child.get("class", []))
        if classes.startswith("Chain___Wrapper"):
            line_group += 1
            position_in_line = 0
            continue
        bib = _find_by_class_prefix(child, "Bib___Wrapper")
        if bib is None:
            continue
        m = BIB_NUM_RE.search(bib.get("aria-label", ""))
        if not m:
            continue
        car_num = int(m.group(1))
        result[car_num] = (
            line_group,
            _LINE_POSITION_NAMES[min(position_in_line, len(_LINE_POSITION_NAMES) - 1)],
        )
        position_in_line += 1
    return result


def _parse_name_cell(cell: Tag) -> dict[str, Any]:
    a = cell.find("a")
    name = a.get_text(strip=True) if a else cell.get_text(" ", strip=True)
    snum = None
    if a and a.get("href"):
        m = CYCLIST_ID_RE.search(a["href"])
        if m:
            snum = "wt" + m.group(1)

    pref_span = cell.find(attrs={"aria-label": True})
    pref = pref_span.get("aria-label") if pref_span else None

    full_text = cell.get_text(" ", strip=True)
    m = NAME_INFO_RE.search(full_text)
    class_rank = m.group(1) if m else None

    return {"name": name, "snum": snum, "pref": pref, "class_rank": class_rank}


def _to_float(value: str) -> float | None:
    try:
        return float(value.replace(",", ""))
    except (TypeError, ValueError):
        return None


def _to_int(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value.replace(",", ""))
    except (TypeError, ValueError):
        return None


def parse_racecard(html: str, cup_id: str, day: int, race_no: int) -> RaceData | None:
    soup = BeautifulSoup(html, "html.parser")

    heading = None
    for h in soup.find_all(["h1", "h2"]):
        txt = h.get_text(" ", strip=True)
        if "発走" in txt and "R" in txt:
            heading = txt
            break
    if heading is None:
        return None
    m = HEADING_RE.search(heading)
    if not m:
        return None
    g = m.groupdict()

    title = soup.title.get_text() if soup.title else ""
    venue_m = re.match(r"^(.+?)競輪", title)
    keirinjo_name = venue_m.group(1) if venue_m else ""
    jocd = cup_id[8:]

    race = RaceData(
        kaisai_date=f"{g['year']}{int(g['month']):02d}{int(g['day']):02d}",
        jocd=jocd,
        keirinjo_name=keirinjo_name,
        race_no=int(g["race_no"]),
        encp=f"wt:{cup_id}/{day}/{race_no}",
        syumoku=g["syumoku"],
        grade_kbn=g["grade"],
        kyori=int(g["kyori"].replace(",", "")),
        shukai=int(g["shukai"]),
        start_time=g["start_time"],
    )

    tables = soup.find_all("table")
    if len(tables) < 2:
        return None
    detail_table = tables[1]
    rows = detail_table.find_all("tr")
    if not rows:
        return None
    header_cells = [c.get_text(strip=True) for c in rows[0].find_all(["th", "td"])]
    col = {name: i for i, name in enumerate(header_cells)}

    def get_cell(cells: list[Tag], key: str) -> Tag | None:
        # 枠(waku)列はrowspanで前の行と共有されることがあり、その行だけ
        # セル数が header より少なくなる。欠けているのは先頭列(枠)である
        # 前提で、そのぶんインデックスを後ろにずらして拾う。
        idx = col.get(key)
        if idx is None:
            return None
        skip = len(header_cells) - len(cells)
        idx -= skip
        if idx < 0 or idx >= len(cells):
            return None
        return cells[idx]

    def cell_text(cells: list[Tag], key: str) -> str | None:
        cell = get_cell(cells, key)
        return cell.get_text(strip=True) if cell is not None else None

    def find_car_num(cells: list[Tag]) -> int | None:
        for c in cells:
            bib = c.find(class_=re.compile(r"EntryTable___EntryNumber"))
            if bib is not None:
                m = BIB_NUM_RE.search(bib.get("aria-label", ""))
                if m:
                    return int(m.group(1))
        return None

    line_info = parse_line_formation(soup)

    for row in rows[1:]:
        cells = row.find_all(["th", "td"])
        if len(cells) < 3:
            continue
        car_num = find_car_num(cells)
        if car_num is None:
            continue
        name_cell = get_cell(cells, "選手名")
        name_info = _parse_name_cell(name_cell) if name_cell is not None else {}
        entry: dict[str, Any] = {
            "car_num": car_num,
            "snum": name_info.get("snum") or f"wt-unknown-{cup_id}-{car_num}",
            "name": name_info.get("name"),
            "pref": name_info.get("pref"),
            "class_rank": name_info.get("class_rank"),
            "prev_class_rank": None,
            "kyakushitsu": cell_text(cells, "脚"),
            "heikin_tokuten": _to_float(cell_text(cells, "競走得点") or ""),
            "syouritu": _to_float(cell_text(cells, "勝率") or ""),
            "rentairitu2": _to_float(cell_text(cells, "２連対率") or ""),
            "rentairitu3": _to_float(cell_text(cells, "３連対率") or ""),
            # 「1着・2着に入った際の勝ち方の回数」（WINTICKET公式ヘルプの説明文）。
            # 選手個人の得意な決まり手（逃げ/捲り/差し/マーク）を表す。
            "kimarite_nige_count": _to_int(cell_text(cells, "逃")),
            "kimarite_makuri_count": _to_int(cell_text(cells, "捲")),
            "kimarite_sashi_count": _to_int(cell_text(cells, "差")),
            "kimarite_mark_count": _to_int(cell_text(cells, "マ")),
            # S/H/B（WINTICKET公式ヘルプの説明文）。
            # S=好スタート回数、H=最終周回ホーム線を先頭通過した回数、
            # B=最終周回バック線を先頭通過した回数（着順への影響が大きいとされる）。
            "standing_count": _to_int(cell_text(cells, "S")),
            "home_lead_count": _to_int(cell_text(cells, "H")),
            "back_lead_count": _to_int(cell_text(cells, "B")),
            # 選手本人の直前コメント（例:「自力。」「◯◯君。」でマーク相手を名指し）。
            # レース終了後もページに残るため過去レース分もbackfill_comments.pyで取得できる。
            "pre_race_comment": cell_text(cells, "コメント"),
            # ギヤ倍率。同一選手でもレースごとに変わりうる（同日の変更は脚質転換の
            # サインとされる）ため、racers.gear_ratio（未使用・常にNULL）とは別に
            # entries側に保存する。
            "gear_ratio": _to_float(cell_text(cells, "ギヤ倍率") or ""),
        }
        if car_num in line_info:
            entry["line_group"], entry["line_position"] = line_info[car_num]
        race.entries.append(entry)

    return race


_PRELOADED_STATE_MARKER = "window.__PRELOADED_STATE__ = "


def load_preloaded_state(html: str) -> Any | None:
    """ページに埋め込まれたReact Queryのキャッシュ(window.__PRELOADED_STATE__)を読む。"""
    idx = html.find(_PRELOADED_STATE_MARKER)
    if idx == -1:
        return None
    try:
        state, _ = json.JSONDecoder().raw_decode(html, idx + len(_PRELOADED_STATE_MARKER))
    except ValueError:
        return None
    return state


def iter_state_dicts(node: Any):
    # 再帰だと巨大なstateで再帰上限に触れうるため、明示的なスタックで辿る
    stack = [node]
    while stack:
        cur = stack.pop()
        if isinstance(cur, dict):
            yield cur
            stack.extend(cur.values())
        elif isinstance(cur, list):
            stack.extend(cur)


def state_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def parse_race_cancelled(html: str, kaisai_date: str, jocd: str, race_no: int) -> bool | None:
    """ページのstateからそのレースの中止フラグを読む（読めなければNone）。

    中止レースは着順が永久に入らないため、記録しておかないと「未完了のレース」として
    毎回の同期で取り直し続けてしまう（静岡9/19 3Rを37回取り直していた。2026-10判明）。
    レースの scheduleId は「開催日(YYYYMMDD)+開催場コード」。"""
    state = load_preloaded_state(html)
    if state is None:
        return None
    sid = f"{kaisai_date}{jocd}"
    for node in iter_state_dicts(state):
        if str(node.get("scheduleId")) == sid and state_int(node.get("number")) == race_no and "cancel" in node:
            return bool(node["cancel"])
    return None


def mark_race_cancelled(encp: str) -> None:
    client = get_client()
    try:
        client.execute("UPDATE races SET cancelled = 1 WHERE encp = ?", [encp])
    finally:
        client.close()


def parse_interviews(html: str) -> list[dict[str, Any]]:
    """出走表ページに埋め込まれたReact Queryキャッシュ(window.__PRELOADED_STATE__)から
    前検日インタビュー(queryKeyに"INSPECTION_DAY_INTERVIEW_LIST"を含むエントリ)の
    質問と回答を抜き出す。entries.pre_race_commentの「自力。」のような一言とは別に、
    記者の質問（「どう走りますか？」等）に対する文章での回答が入っており、
    直近の調子や連係する選手の名前など、脚質・ラインからは拾えない情報を含む。

    出走表HTML自体にはこのJSONは無いレースもある（前検日前など）ため、
    見つからなければ空リストを返す。"""
    idx = html.find(_PRELOADED_STATE_MARKER)
    if idx == -1:
        return []
    start = idx + len(_PRELOADED_STATE_MARKER)
    try:
        state, _ = json.JSONDecoder().raw_decode(html, start)
    except (json.JSONDecodeError, ValueError):
        return []

    interviews: list[dict[str, Any]] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            query_key = node.get("queryKey")
            if isinstance(query_key, list) and any(
                isinstance(k, str) and "INSPECTION_DAY_INTERVIEW_LIST" in k for k in query_key
            ):
                data = ((node.get("state") or {}).get("data")) or {}
                for item in data.get("interviews") or []:
                    player_id = item.get("playerId")
                    if not player_id:
                        continue
                    for thread in item.get("threads") or []:
                        answer = thread.get("answer")
                        if not answer:
                            continue
                        interviews.append({
                            "snum": "wt" + str(player_id),
                            "question": thread.get("question"),
                            "answer": answer,
                        })
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(state)
    return interviews


def parse_raceresult(html: str, race: RaceData) -> None:
    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table")
    if not tables:
        return

    result_table = tables[0]
    rows = result_table.find_all("tr")
    if not rows:
        return
    header_cells = [c.get_text(strip=True) for c in rows[0].find_all(["th", "td"])]
    col = {name: i for i, name in enumerate(header_cells)}
    by_car = {e["car_num"]: e for e in race.entries}

    for row in rows[1:]:
        cells = row.find_all(["th", "td"])
        if len(cells) < 3:
            continue

        def cell_text(key: str) -> str | None:
            idx = col.get(key)
            if idx is None or idx >= len(cells):
                return None
            return cells[idx].get_text(strip=True)

        finish_text = cell_text("着")
        car_text = cell_text("車")
        if not finish_text or not finish_text.isdigit() or not car_text or not car_text.isdigit():
            continue
        car_num = int(car_text)
        entry = by_car.get(car_num)
        snum = entry["snum"] if entry else f"wt-unknown-{race.jocd}-{car_num}"
        kimarite = cell_text("決") or None
        agari_time = _to_float(cell_text("上り"))
        race.results.append({
            "car_num": car_num,
            "snum": snum,
            "finish_pos": int(finish_text),
            "kimarite": kimarite,
            "agari_time": agari_time,
        })

    if len(tables) < 2:
        return
    race.odds.extend(parse_sanrentan_payout(tables[1]))


def parse_sanrentan_payout(payout_table: Tag) -> list[dict[str, Any]]:
    """結果ページの払戻金テーブルから3連単の行だけを抜き出す。
    parse_raceresultと、着順・出走表を必要としない軽量バックフィル
    （backfill_ninki.py、既存odds行の「人気」だけ後から埋める）の両方から使う。"""
    odds: list[dict[str, Any]] = []
    for row in payout_table.find_all("tr"):
        cells = [c.get_text(" ", strip=True) for c in row.find_all(["th", "td"])]
        if len(cells) >= 3 and cells[0] == "3連単":
            combination = cells[1].replace("=", "-")
            payout_yen = _to_float(re.sub(r"[^\d.]", "", cells[2]))
            # 「人気」列（例:"(3)"）。的中組み合わせが3連単の中で何番目に売れて
            # いたか。WINTICKET側が算出済みの値をそのまま貰う（発走前の全組み合わせ
            # オッズボードは保存しておらず自前では算出できないため）。
            ninki = None
            if len(cells) >= 4:
                ninki_match = re.search(r"\((\d+)\)", cells[3])
                if ninki_match:
                    ninki = int(ninki_match.group(1))
            if payout_yen is not None:
                odds.append({
                    "bet_type": "3連単",
                    "combination": combination,
                    "odds_value": payout_yen / 100,
                    "ninki": ninki,
                })
    return odds


JST = datetime.timezone(datetime.timedelta(hours=9))
# (cup_id, day) → その日の最終レース番号（出走表のリンクから判明したもの）
_day_race_counts: dict[tuple[str, int], int] = {}
# 発走時刻からこの分数が経つまでは結果ページを見ない（確定前に取っても空のため）。
RESULT_READY_AFTER_MIN = 5


def _not_started_yet(race: RaceData) -> bool:
    """発走時刻+RESULT_READY_AFTER_MIN分より前ならTrue。時刻が読めなければFalse（従来通り取得）。"""
    if not race.start_time or not race.kaisai_date:
        return False
    try:
        start = datetime.datetime.strptime(
            f"{race.kaisai_date} {race.start_time}", "%Y%m%d %H:%M"
        ).replace(tzinfo=JST)
    except ValueError:
        return False
    ready = start + datetime.timedelta(minutes=RESULT_READY_AFTER_MIN)
    return datetime.datetime.now(JST) < ready


def scrape_one_race(venue: str, cup_id: str, day: int, race_no: int) -> Any:
    """1レース分を取得する。

    戻り値:
      (RaceData, histories) 取得成功
      RACE_NOT_FOUND        404。そのレース番号は存在しない＝その日の打ち止め
      None                  取得失敗・解析失敗。打ち止めとは限らないので、
                            呼び出し側は「この日を列挙し切った」と扱ってはいけない
    """
    status, html = _get(f"https://winticket.jp/keirin/{venue}/racecard/{cup_id}/{day}/{race_no}")
    _sleep()
    if status == 404:
        return RACE_NOT_FOUND
    if status != 200:
        print(f"  警告: racecard取得失敗 status={status} {venue}/{cup_id}/{day}/{race_no}")
        return None
    # 出走表にはその日の全レース（1R〜最終R）へのリンクが並ぶので、最終レース番号が
    # 分かる。以前は最終Rの次のレースを取りに行って404で打ち止めを判定していた。
    race_nos = [int(n) for n in re.findall(rf"/racecard/{cup_id}/{day}/(\d+)", html)]
    if race_nos:
        _day_race_counts[(cup_id, day)] = max(race_nos)
    race = parse_racecard(html, cup_id, day, race_no)
    if race is None or not race.entries:
        # 解析できなかった場合も打ち止めとは限らないため None を返す
        return None
    race.interviews = parse_interviews(html)
    # 中止レースは結果ページを見ても何も無い。保存時にcancelledを立てて以後の取得対象から外す。
    race.cancelled = bool(parse_race_cancelled(html, race.kaisai_date, race.jocd, race.race_no))
    if race.cancelled:
        return race, enrich_entries_with_history(race.entries)

    # 発走前のレースは結果ページがまだ無いので取りに行かない。朝の同期では取得
    # レースの約8割が発走前で、結果ページへの無駄なアクセスとその待ち時間が
    # 同期時間の大半を占めていた（2026-10実測：78レース中60レースが結果0件）。
    if not _not_started_yet(race):
        status, html = _get(f"https://winticket.jp/keirin/{venue}/raceresult/{cup_id}/{day}/{race_no}")
        _sleep()
        if status == 200:
            parse_raceresult(html, race)

    histories = enrich_entries_with_history(race.entries)

    return race, histories


def load_completed_days(since_date: datetime.date) -> set[tuple[str, str]]:
    """(jocd, kaisai_date) のうち、その日の全レースの着順が既に揃っている組を返す。

    レースが終わって着順が確定した日は取り直しても内容が変わらないため、
    HTTPアクセスを丸ごと省くための判定材料に使う。開催場ごとに問い合わせると
    Tursoの読取行数が積み上がるので、1クエリで全開催場ぶんまとめて取る。

    注意：判定は着順(results.finish_pos)の有無だけを見ている。着順は揃って
    いるがオッズが欠けている日はスキップ対象になるため、この経路ではオッズの
    後追い補完はされない（repair_gaps.pyが日次で拾う）。中止レース（cancelled=1）は
    着順が永久に入らないので完了扱いにする（でないとその日を毎回取り直し続ける）。
    """
    since_str = since_date.strftime("%Y%m%d")
    client = get_client()
    try:
        result = client.execute(
            """
            SELECT ra.jocd, ra.kaisai_date
            FROM races ra
            LEFT JOIN (
                SELECT DISTINCT race_id FROM results WHERE finish_pos IS NOT NULL
            ) res ON res.race_id = ra.id
            WHERE ra.kaisai_date >= ?
            GROUP BY ra.jocd, ra.kaisai_date
            HAVING COUNT(*) = SUM(CASE WHEN res.race_id IS NOT NULL OR ra.cancelled = 1 THEN 1 ELSE 0 END)
            """,
            [since_str],
        )
    finally:
        client.close()
    return {(str(row[0]), str(row[1])) for row in result.rows}


def load_completed_races(since_date: datetime.date) -> set[str]:
    """着順（3着まで）と3連単払戻が既に保存済みのレースを "cup_id/day/race_no" で返す。

    load_completed_daysは「その日の全レースが確定」した日しか省けないため、開催中の
    日は確定済みの前半レースも毎回出走表・結果ページを取り直していた（2026-10実測：
    夕方の同期で四日市・別府の1〜6Rを再取得し、1レース10〜16秒×6を使っていた）。
    確定後は内容が変わらないのでレース単位でも省く。
    """
    since_str = since_date.strftime("%Y%m%d")
    client = get_client()
    try:
        result = client.execute(
            """
            SELECT ra.encp
            FROM races ra
            WHERE ra.kaisai_date >= ? AND substr(ra.encp, 1, 3) = 'wt:'
              AND (ra.cancelled = 1 OR (
                (SELECT COUNT(*) FROM results r
                  WHERE r.race_id = ra.id AND r.finish_pos BETWEEN 1 AND 3) >= 3
                AND EXISTS (SELECT 1 FROM odds o WHERE o.race_id = ra.id AND o.bet_type = '3連単')))
            """,
            [since_str],
        )
    finally:
        client.close()
    return {str(row[0])[3:] for row in result.rows}


def load_active_jocds(dates: list[str]) -> set[str]:
    """指定日（当日・翌日）にレースがDBに登録済みの開催場コード。並列処理の先頭に回す。"""
    client = get_client()
    try:
        result = client.execute(
            f"SELECT DISTINCT jocd FROM races WHERE kaisai_date IN ({','.join('?' for _ in dates)})",
            dates,
        )
    finally:
        client.close()
    return {str(row[0]) for row in result.rows}


def scrape_cup(
    venue: str,
    cup_id: str,
    max_days: int = 7,
    max_races: int = 12,
    completed_days: set[tuple[str, str]] | None = None,
    completed_races: set[str] | None = None,
) -> list[tuple[RaceData, list[RacerHistoryEntry]]]:
    jocd = cup_id[8:]
    try:
        cup_start: datetime.date | None = datetime.datetime.strptime(
            cup_id[:8], "%Y%m%d"
        ).date()
    except ValueError:
        # cup_idの形式が想定外なら日付を推定できないので、スキップ判定は行わない
        cup_start = None

    # 翌日(JST)より後の日程は出走表がまだ公開されておらず、取りに行っても404で
    # 打ち止めを確認するだけの空振りになる。推定日が実際より早い（休催日がある）場合は
    # 実際の日付も翌日より後なので、ここで打ち切っても取りこぼしは起きない。
    tomorrow_str = (datetime.datetime.now(JST).date() + datetime.timedelta(days=1)).strftime("%Y%m%d")

    races: list[tuple[RaceData, list[RacerHistoryEntry]]] = []
    for day in range(1, max_days + 1):
        if cup_start is not None:
            if (cup_start + datetime.timedelta(days=day - 1)).strftime("%Y%m%d") > tomorrow_str:
                break
        # 開催日は初日から連続しているものとして日付を推定し、その日が
        # 「全レースの着順が揃っている日」に該当するときだけ取得を省く。
        # 推定が外れて該当しなければ従来どおり取得するため、スキップ判定の
        # 誤りで取り逃すことはない（安全側に倒している）。
        if completed_days and cup_start is not None:
            guess = (cup_start + datetime.timedelta(days=day - 1)).strftime("%Y%m%d")
            if (jocd, guess) in completed_days:
                print(f"  スキップ: {cup_id} day{day} ({guess}) は着順が揃っているため取得しない")
                continue
        day_had_race = False
        day_ended_cleanly = False
        for race_no in range(1, max_races + 1):
            last_race_no = _day_race_counts.get((cup_id, day))
            if last_race_no is not None and race_no > last_race_no:
                day_ended_cleanly = True
                break
            if completed_races and f"{cup_id}/{day}/{race_no}" in completed_races:
                day_had_race = True
                continue
            result = scrape_one_race(venue, cup_id, day, race_no)
            if result is RACE_NOT_FOUND:
                # race_no-1件で打ち止め（race_no==1ならこの日は開催なし）
                day_ended_cleanly = True
                break
            if result is None:
                # 取得・解析の失敗。打ち止めか一時的な失敗か区別できないので、
                # この日を列挙し切ったとは扱わない（次回の実行で取り直す）。
                print(f"  警告: {cup_id} day{day} {race_no}R で失敗。この日は未完了として扱う")
                break
            day_had_race = True
            races.append(result)
            race, histories = result
            print(f"  取得: {race.keirinjo_name} {race.race_no}R ({race.kaisai_date}) "
                  f"選手{len(race.entries)}名 / 結果{len(race.results)}件 / オッズ{len(race.odds)}件 / "
                  f"選手成績補完{len(histories)}件")
        if not day_had_race and day_ended_cleanly:
            break  # 1レースも存在しない日に当たった＝これ以上の日程はなし
    return races


# jocd(開催場コード) → WINTICKETの開催場スラッグ。WINTICKET側にjocdからスラッグへの
# 対応表が公開されていないため、日程ページを実際に叩いて確認した実測値（当時のDBの
# races.jocd/keirinjo_nameとの突き合わせ含む）。千葉・福井・向日町・高松の4場は
# 調査当時レースが観測できず未確認のため意図的に含めていない（sync_results_only.py
# はこの4場のレースだけ結果取得をスキップする）。app/lib/winticket.tsに同じ内容がある。
JOCD_TO_WINTICKET_SLUG = {
    "11": "hakodate", "12": "aomori", "13": "iwakidaira", "21": "yahiko",
    "22": "maebashi", "23": "toride", "24": "utsunomiya", "25": "omiya",
    "26": "seibuen", "27": "keiokaku", "28": "tachikawa", "31": "matsudo",
    "34": "kawasaki", "35": "hiratsuka", "36": "odawara", "37": "ito",
    "38": "shizuoka", "42": "nagoya", "43": "gifu", "44": "ogaki",
    "45": "toyohashi", "46": "toyama", "47": "matsusaka", "48": "yokkaichi",
    "53": "nara", "55": "wakayama", "56": "kishiwada", "61": "tamano",
    "62": "hiroshima", "63": "hofu", "73": "komatsushima", "74": "kochi",
    "75": "matsuyama", "81": "kokura", "83": "kurume", "84": "takeo",
    "85": "sasebo", "86": "beppu", "87": "kumamoto",
}

ALL_VENUE_SLUGS = [
    "hakodate", "aomori", "iwakidaira", "yahiko", "maebashi", "toride", "utsunomiya",
    "omiya", "seibuen", "keiokaku", "tachikawa", "matsudo", "chiba", "kawasaki",
    "hiratsuka", "odawara", "ito", "shizuoka", "nagoya", "gifu", "ogaki", "toyohashi",
    "toyama", "matsusaka", "yokkaichi", "fukui", "nara", "mukomachi", "wakayama",
    "kishiwada", "tamano", "hiroshima", "hofu", "takamatsu", "komatsushima", "kochi",
    "matsuyama", "kokura", "kurume", "takeo", "sasebo", "beppu", "kumamoto",
]


def _month_range(start: datetime.date, end: datetime.date) -> list[str]:
    """start〜end（両端の月を含む）をYYYYMM文字列で月単位に列挙する。

    例: start=2026-04-09, end=2026-08-07 -> ["202604","202605","202606","202607","202608"]
    """
    months: list[str] = []
    cur = start.replace(day=1)
    end_marker = end.replace(day=1)
    while cur <= end_marker:
        months.append(cur.strftime("%Y%m"))
        cur = (cur.replace(day=28) + datetime.timedelta(days=4)).replace(day=1)
    return months


def scrape_venue_recent(
    venue: str,
    since_date: datetime.date,
    on_race=None,
    completed_days: set[tuple[str, str]] | None = None,
    completed_races: set[str] | None = None,
) -> list[tuple[RaceData, list[RacerHistoryEntry]]]:
    """指定開催場について、since_date以降にレースがある開催(cup)を全て取得する。

    on_raceを渡すと、レースを1件取得するたびに呼び出す（中断されても
    それまでの取得分がDBに残るよう、逐次保存するために使う）。

    注意：以前はsince_dateの月と今月の2つしかスケジュールページを見ておらず、
    その間の月（例: since_dateが4か月前なら5〜7月）が丸ごと抜け落ちるバグが
    あった。_month_rangeで間の月も含めて全て列挙する。
    """
    # cup_idの先頭8桁は開催初日なので、since_date以降に「開始した」開催だけを
    # 選ぶと、since_dateより前に始まった開催の後半日程が丸ごと落ちる。3日開催
    # なら毎開催の最終日の着順が永久に取得できないバグになっていた。
    # CUP_LOOKBACK_DAYSぶん手前から候補に入れ、既に着順が揃っている日は
    # scrape_cup側でスキップしてアクセス増を打ち消す。
    cup_since = since_date - datetime.timedelta(days=CUP_LOOKBACK_DAYS)
    months = _month_range(cup_since, datetime.date.today())
    cup_ids: list[str] = []
    for yyyymm in months:
        cup_ids.extend(discover_cup_ids(venue, yyyymm))
    cup_ids = sorted(set(cup_ids))

    cup_since_str = cup_since.strftime("%Y%m%d")
    # 翌日より後に始まる開催はまだ出走表が出ていない（1Rが404で終わるだけの空振り
    # アクセスになる）ので対象外。日付はGitHub ActionsのUTCではなくJSTで判定する。
    cup_until_str = (datetime.datetime.now(JST).date() + datetime.timedelta(days=1)).strftime("%Y%m%d")
    target_cups = [c for c in cup_ids if cup_since_str <= c[:8] <= cup_until_str]

    all_races: list[tuple[RaceData, list[RacerHistoryEntry]]] = []
    for cup_id in target_cups:
        print(f"開催 {venue}/{cup_id} を取得中...")
        cup_races = scrape_cup(
            venue, cup_id, completed_days=completed_days, completed_races=completed_races
        )
        for result in cup_races:
            if on_race is not None:
                on_race(result)
        all_races.extend(cup_races)
    return all_races


def _process_venue(
    venue: str,
    since_date: datetime.date,
    completed_days: set[tuple[str, str]],
    completed_races: set[str],
) -> int:
    print(f"=== {venue} ===")

    def save_one(result: tuple[RaceData, list[RacerHistoryEntry]]) -> None:
        race, histories = result
        save_to_db(race, bank_info=None, histories=histories)
        if getattr(race, "cancelled", False):
            mark_race_cancelled(race.encp)

    races = scrape_venue_recent(
        venue,
        since_date,
        on_race=save_one,
        completed_days=completed_days,
        completed_races=completed_races,
    )
    print(f"{venue}: {len(races)}件保存")
    return len(races)


def main() -> None:
    parser = argparse.ArgumentParser(description="WINTICKETから過去レースを取得してTursoに保存する")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--venue", help="開催場のURLスラッグ（例: iwakidaira）")
    group.add_argument(
        "--all-venues", action="store_true", help="全43開催場を対象にする（節度あるアクセス間隔のため長時間かかる）"
    )
    parser.add_argument("--days-back", type=int, default=7, help="何日前まで遡るか（デフォルト7日）")
    parser.add_argument(
        "--concurrency",
        type=int,
        default=VENUE_CONCURRENCY,
        help=f"--all-venues時に同時処理する開催場数（デフォルト{VENUE_CONCURRENCY}）",
    )
    parser.add_argument(
        "--refresh-schedule",
        action="store_true",
        help="月間日程ページのキャッシュを使わず取り直す（通常はJSTの日付が変わって最初の実行で自動的に取り直す）",
    )
    args = parser.parse_args()

    global FORCE_SCHEDULE_REFRESH
    FORCE_SCHEDULE_REFRESH = args.refresh_schedule
    load_schedule_cache()

    since_date = datetime.date.today() - datetime.timedelta(days=args.days_back)
    venues = ALL_VENUE_SLUGS if args.all_venues else [args.venue]

    # 着順が揃っている日は取り直しても内容が変わらないので、ここで1回だけ
    # 問い合わせて全開催場ぶんの判定材料を用意する（cupの選択窓を広げた分の
    # アクセス増を打ち消すのが目的）。
    completed_days = load_completed_days(
        since_date - datetime.timedelta(days=CUP_LOOKBACK_DAYS)
    )
    print(f"着順が揃っている開催日: {len(completed_days)}件（この日は取得をスキップする）")
    completed_races = load_completed_races(since_date - datetime.timedelta(days=CUP_LOOKBACK_DAYS))
    print(f"確定済みレース: {len(completed_races)}件（レース単位でも取得をスキップする）")

    # 当日・翌日にレースがある開催場を先に処理する。以前はアルファベット順で、
    # レースの無い開催場（日程ページを見るだけ）を先に何十場も処理してから
    # 実際にレースのある開催場に着手しており、全体の所要時間を引き延ばしていた。
    today_jst = datetime.datetime.now(JST).date()
    active_dates = [(today_jst + datetime.timedelta(days=d)).strftime("%Y%m%d") for d in (0, 1)]
    active_slugs = {JOCD_TO_WINTICKET_SLUG.get(j) for j in load_active_jocds(active_dates)}
    venues = sorted(venues, key=lambda v: 0 if v in active_slugs else 1)

    # --venue（単一開催場）はconcurrency=1と同義になり、実質これまで通り逐次実行。
    concurrency = max(1, args.concurrency) if args.all_venues else 1

    total = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        future_to_venue = {
            executor.submit(_process_venue, venue, since_date, completed_days, completed_races): venue
            for venue in venues
        }
        for future in concurrent.futures.as_completed(future_to_venue):
            venue = future_to_venue[future]
            try:
                total += future.result()
            except Exception as exc:  # noqa: BLE001 - 1開催場の失敗で全体を止めない
                print(f"  警告: {venue} の処理中に例外が発生し中断: {exc}")

    print(f"\n合計 {total} レースを保存しました（Turso）")


if __name__ == "__main__":
    main()
