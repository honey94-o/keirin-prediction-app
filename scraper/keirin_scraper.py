"""KEIRIN.JP から1レース分のデータを取得し、DBに保存するスクレイピングモジュール。

個人利用・低頻度実行を前提とする。サイト構造の変化に弱いため、
動かなくなったら本ファイルの各 parse_* 関数を実際のJSONレスポンスと
突き合わせて調整すること。

使い方（対話的に1レースだけ取得する場合）:
    python keirin_scraper.py --list-venues
    python keirin_scraper.py --venue-index 0 --race-no 1

注意:
- KEIRIN.JPのrobots.txtは出走表・オッズ・結果の個別ページを許可リストに
  含めていない（開催日程・選手プロフィール等の一部ページのみ許可）。
  本スクリプトは個人利用の範囲と判断してrobots.txt非準拠で実装しているが、
  アクセス頻度は必ず抑制すること（REQUEST_INTERVAL_SEC を短くしない）。
"""
from __future__ import annotations

import argparse
import datetime
import re
import time
from dataclasses import dataclass, field
from typing import Any

from playwright.sync_api import Page, sync_playwright

from db import get_client

# 自分自身が何者かを明示し、アクセス間隔を空ける（節度あるアクセス）
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "keirin-prediction-app/0.1 (personal use, non-commercial prediction tool)"
)
REQUEST_INTERVAL_SEC = 2.0


def _sleep():
    time.sleep(REQUEST_INTERVAL_SEC)


@dataclass
class RaceData:
    kaisai_date: str
    jocd: str
    keirinjo_name: str
    race_no: int
    encp: str
    syumoku: str | None = None
    grade_kbn: str | None = None
    kyori: int | None = None
    shukai: int | None = None
    start_time: str | None = None
    entries: list[dict[str, Any]] = field(default_factory=list)
    results: list[dict[str, Any]] = field(default_factory=list)
    odds: list[dict[str, Any]] = field(default_factory=list)
    tenki: str | None = None
    husoku: float | None = None


@dataclass
class BankInfo:
    jocd: str
    keirinjo_name: str | None = None
    shuutyou: int | None = None
    tyokusen: str | None = None
    kant: str | None = None
    tkant: str | None = None
    home_hukuin: str | None = None
    back_hukuin: str | None = None
    center_hukuin: str | None = None
    nige_pct: float | None = None
    makuri_pct: float | None = None
    sashi_pct: float | None = None
    feature_text: str | None = None


@dataclass
class RacerHistoryEntry:
    snum: str
    race_date: str
    venue_abbr: str
    finish_positions: str  # カンマ区切り "6,5,5"


def _unique_venue_links(page: Page) -> list:
    """votinglistページの開催場リンクを、開催場名で重複排除して返す。

    ページ内には同じ開催場へのリンクがティッカー等で複数回出現するため、
    表示ラベル（開催場名）ベースで最初の1件のみを採用する。
    """
    links = page.query_selector_all("a[onclick^='kaisaijoLinkClick']")
    seen: set[str] = set()
    unique = []
    for link in links:
        label = (link.inner_text() or "").strip()
        if not label or label in seen:
            continue
        seen.add(label)
        unique.append(link)
    return unique


def list_today_venues(page: Page) -> list[dict[str, Any]]:
    """本日発売中の開催場一覧を返す（votinglistページの遷移リンクから）。"""
    page.goto("https://keirin.jp/pc/votinglist", wait_until="networkidle", timeout=20000)
    page.wait_for_timeout(500)
    links = _unique_venue_links(page)
    venues = []
    for i, link in enumerate(links):
        text = (link.inner_text() or "").strip()
        venues.append({"index": i, "label": text or f"venue_{i}"})
    return venues


def _switch_to_today(page: Page) -> None:
    """複数日開催の場合、racelistページはデフォルトで初日を表示するため、
    本日の日付タブ（#hhspnRaceDateN）を探してクリックし本日のカードに切り替える。

    単日開催（日付タブが無い）の場合は何もしない。
    """
    import datetime

    today_md = datetime.date.today().strftime("%m/%d")
    tabs = page.query_selector_all("[id^='hhspnRaceDate']")
    for tab in tabs:
        text = (tab.inner_text() or "").strip()
        if text.startswith(today_md):
            tab.click()
            page.wait_for_timeout(1200)
            _sleep()
            return


def open_venue(page: Page, venue_index: int) -> dict[str, Any]:
    """指定した開催場のracelistページを開き、本日の開催情報(pc0101_json)を返す。"""
    page.goto("https://keirin.jp/pc/votinglist", wait_until="networkidle", timeout=20000)
    page.wait_for_timeout(500)
    links = _unique_venue_links(page)
    if venue_index >= len(links):
        raise IndexError(f"venue_index {venue_index} out of range (found {len(links)} venues)")
    with page.expect_navigation(wait_until="networkidle", timeout=20000):
        links[venue_index].click()
    _sleep()
    _switch_to_today(page)
    pc0101 = page.evaluate("() => window.pc0101_json || null")
    if not pc0101:
        raise RuntimeError("pc0101_json not found on racelist page — site structure may have changed")
    return pc0101


def open_race(page: Page, race_no: int) -> str:
    """レース番号のボタンをクリックしてレース詳細ページへ遷移し、encpトークンを返す。"""
    btn = page.query_selector(f"#hhRaceBtn{race_no}")
    if btn is None:
        raise RuntimeError(f"hhRaceBtn{race_no} not found — race may not exist for this venue/day")
    encp = btn.get_attribute("data-encp")
    # 表示状態に関わらずクリックイベントを発火させる（サイト側UIの都合で非表示のため）
    page.evaluate(f"document.querySelector('#hhRaceBtn{race_no}').click()")
    page.wait_for_timeout(1500)
    _sleep()
    if not encp:
        raise RuntimeError(f"data-encp not found on hhRaceBtn{race_no}")
    return encp


class JsonCapture:
    """ページが自発的に発行する /pc/json?type=XXX 応答を横取りして保持する。

    JSFベースのサーバはセッション状態に敏感で、type別のJSON URLを
    こちらから独立に再現してGETしても500になることがある（実測済み）。
    そのため、実際にサイトのUIボタンをクリックしてサイト自身に
    リクエストを発行させ、その応答だけを収集する方式にしている。
    """

    def __init__(self, page: Page):
        self.page = page
        self.responses: dict[str, dict[str, Any]] = {}
        page.on("response", self._on_response)

    def _on_response(self, res):
        if "/pc/json" in res.url and "type=" in res.url:
            json_type = res.url.split("type=")[-1].split("&")[0]
            try:
                self.responses[json_type] = res.json()
            except Exception:
                pass

    def wait_for(self, json_type: str, timeout_sec: float = 10.0) -> dict[str, Any]:
        waited = 0.0
        while json_type not in self.responses and waited < timeout_sec:
            self.page.wait_for_timeout(200)
            waited += 0.2
        if json_type not in self.responses:
            raise RuntimeError(f"{json_type} response not captured within {timeout_sec}s")
        return self.responses[json_type]


def parse_basic_info(json_data: dict[str, Any]) -> RaceData:
    c = json_data["C0201data"]
    detail = c["C0201racedtl"]
    race = RaceData(
        kaisai_date=c["selKaisai"],
        jocd=str(c["selKjyoCd"]),
        keirinjo_name=c["joName"],
        race_no=int(c["selRaceNo"]),
        encp=c["encSelParaR"],
        syumoku=detail.get("nameKyosou") or detail.get("syumoku"),
        grade_kbn=c.get("imgGradeAlt"),
        kyori=detail.get("kyori"),
        shukai=detail.get("syukai"),
        start_time=detail.get("aftStartTime") or detail.get("bfrStartTime"),
    )
    for s in detail.get("C0201sensyu", []):
        race.entries.append({
            "car_num": s["carNum"],
            "snum": s["numPlayer"],
            "name": s["imgPlayerPictAlt"] or s["namePlayerSei"],
        })
    return race


def enrich_entries_with_racer_attrs(race: RaceData, jst010: dict[str, Any]) -> None:
    """JST010(オッズ画面用選手情報パネル)から府県・級班・前期級班・脚質を補完する。

    「オッズ画面用」という名前だが、このJSONには実際のオッズ値は含まれず、
    選手属性（車番ごとの府県・級班・脚質）のみが入っている。
    kyuhan2Char=今期級班、MaeKyuhan2Char=前期級班で、比較すると昇級・降級を判定できる。
    """
    by_car = {e["car_num"]: e for e in race.entries}
    for s in jst010["data"].get("sensyuInfoList", []):
        car_num = int(s["syaban"])
        entry = by_car.get(car_num)
        if not entry:
            continue
        entry["pref"] = (s.get("huken3Char") or "").replace("　", "")
        entry["class_rank"] = s.get("kyuhan2Char")
        entry["prev_class_rank"] = s.get("MaeKyuhan2Char")
        entry["kyakushitsu"] = s.get("kyasitu1Char")


def enrich_entries_with_stats(race: RaceData, jsj006: dict[str, Any]) -> None:
    """JSJ006(統計データ)から平均得点・勝率・連対率・3着内率を補完する。"""
    by_car = {e["car_num"]: e for e in race.entries}
    for s in jsj006.get("sensyuTypeInfo", []):
        car_num = int(s["syaban"])
        entry = by_car.get(car_num)
        if not entry:
            continue
        entry["heikin_tokuten"] = _to_float(s.get("heikinTokuten"))
        entry["syouritu"] = _to_float(s.get("syouritu"))
        entry["rentairitu2"] = _to_float(s.get("rentairitu2"))
        entry["rentairitu3"] = _to_float(s.get("rentairitu3"))


def _to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


_LINE_POSITION_NAMES = ["先頭", "番手", "3番手", "4番手", "5番手", "6番手", "7番手"]


def parse_line_formation(race: RaceData, jsj005: dict[str, Any]) -> None:
    """narabiyoso(並び予想)からライン構成（車番のグループ・隊列内の位置）を復元する。

    narabiyoso.shaban は {ichi: 隊列内順序, shaban: 車番} のリスト。
    ichiを昇順に並べ、値が連続しない箇所でライン（グループ）の区切りとみなす
    （公式サイトのライン紹介ダイアグラムが線番between同士に間隔を空けて描画する仕様に基づく）。
    """
    narabiyoso = jsj005.get("narabiyoso", {})
    if narabiyoso.get("ryoikiFlg") != "true" or not narabiyoso.get("shaban"):
        return  # このレースはライン予想が未提供（レース確定前/対象外グレード等）

    ordered = sorted(narabiyoso["shaban"], key=lambda s: int(s["ichi"]))
    by_car = {e["car_num"]: e for e in race.entries}

    line_group = 1
    position_in_line = 0
    prev_ichi = None
    for item in ordered:
        ichi = int(item["ichi"])
        car_num = int(item["shaban"])
        if prev_ichi is not None and ichi - prev_ichi > 1:
            line_group += 1
            position_in_line = 0
        entry = by_car.get(car_num)
        if entry is not None:
            entry["line_group"] = line_group
            entry["line_position"] = _LINE_POSITION_NAMES[min(position_in_line, len(_LINE_POSITION_NAMES) - 1)]
        position_in_line += 1
        prev_ichi = ichi


def parse_results(race: RaceData, jsj012: dict[str, Any]) -> None:
    # 天候・不足はレース終了後の実績値としてのみ提供される（事前予報ではない）
    race.tenki = jsj012.get("tenki") or None
    race.husoku = _to_float(jsj012.get("husoku"))
    for item in jsj012.get("tyakujyunItemSubData", []):
        if not item.get("tyaku") or not item.get("tyaku").isdigit():
            continue
        race.results.append({
            "car_num": int(item["syaban"]),
            "snum": item["sensyuRegistNo"],
            "finish_pos": int(item["tyaku"]),
            "kimarite": item.get("kimarite") or None,
        })


OZZ_KEY_RE = re.compile(r"^OZZ(\d)(\d)(\d)$")


def parse_odds_sanrentan(race: RaceData, jst011: dict[str, Any]) -> None:
    data = jst011.get("data", {}).get("ozz3RentanData", {})
    for key, value in data.items():
        m = OZZ_KEY_RE.match(key)
        if not m:
            continue
        combination = "-".join(m.groups())
        race.odds.append({"bet_type": "3連単", "combination": combination, "odds_value": value})


SHUUTYOU_RE = re.compile(r"bank(\d+)\.gif")


def scrape_bank_info(page: Page, jocd: str) -> BankInfo:
    """開催場ガイドページ(/pc/jyoguide)からバンク特性データを取得する。

    robots.txtで許可されているページなので単独ページ遷移でよい。
    """
    page.goto(f"https://keirin.jp/pc/jyoguide?jocd={jocd}", wait_until="networkidle", timeout=20000)
    page.wait_for_timeout(1000)
    _sleep()
    data = page.evaluate("() => (window.PJ0703json && window.PJ0703json.data) || null")
    if not data:
        raise RuntimeError(f"PJ0703json not found for jocd={jocd} — site structure may have changed")

    shuutyou = None
    m = SHUUTYOU_RE.search(data.get("syutyoImg") or "")
    if m:
        shuutyou = int(m.group(1))

    def _pct(techniq_list: list[dict[str, Any]], name: str) -> float | None:
        for item in techniq_list or []:
            if item.get("iconName") == name:
                return _to_float(item.get("percentCnt"))
        return None

    first_techniq = data.get("firstTechniqList", [])
    feature_text = None
    for item in data.get("jyoInfList", []):
        if item.get("headItem") == "バンク特徴":
            feature_text = item.get("dataItem")
            break

    return BankInfo(
        jocd=jocd,
        shuutyou=shuutyou,
        tyokusen=data.get("tyokusen"),
        kant=data.get("kant"),
        tkant=data.get("tkant"),
        home_hukuin=data.get("homeHukuin"),
        back_hukuin=data.get("backHukuin"),
        center_hukuin=data.get("centerHukuin"),
        nige_pct=_pct(first_techniq, "逃げ"),
        makuri_pct=_pct(first_techniq, "捲り"),
        sashi_pct=_pct(first_techniq, "差し"),
        feature_text=feature_text,
    )


def scrape_racer_history(page: Page, snum: str) -> list[RacerHistoryEntry]:
    """選手プロフィールページ(/pc/racerprofile)の「最近の成績」(直近8走)から
    出走間隔・過去の同条件成績の算出に使う簡易履歴を取得する。

    robots.txtで許可されているページ。
    """
    page.goto(f"https://keirin.jp/pc/racerprofile?snum={snum}", wait_until="networkidle", timeout=20000)
    page.wait_for_timeout(1000)
    _sleep()
    raw = page.evaluate(
        """() => Array.from(document.querySelectorAll('table.seiseki_kobetsu')).map(t => {
            const firstRow = t.querySelector('tr');
            const cells = firstRow ? firstRow.children : [];
            const date = cells[0] ? cells[0].textContent.trim() : '';
            const venue = cells[1] ? cells[1].textContent.trim() : '';
            const badges = Array.from(t.querySelectorAll('.imgbadge_s4'))
                .map(b => b.getAttribute('title'))
                .filter(Boolean);
            return { date, venue, badges };
        }).filter(r => r.date)"""
    )
    return [
        RacerHistoryEntry(
            snum=snum,
            race_date=r["date"],
            venue_abbr=r["venue"],
            finish_positions=",".join(r["badges"]),
        )
        for r in raw
    ]


def _days_since_update(query: str, params: tuple) -> float | None:
    client = get_client()
    try:
        result = client.execute(query, list(params))
    finally:
        client.close()
    if not result.rows or not result.rows[0][0]:
        return None
    updated = datetime.datetime.fromisoformat(result.rows[0][0])
    return (datetime.datetime.now() - updated).total_seconds() / 86400


BANK_INFO_MAX_AGE_DAYS = 30  # バンク特性はほぼ不変なので長めのキャッシュ
RACER_HISTORY_MAX_AGE_DAYS = 1  # 選手成績は日々更新されるので短め


def scrape_one_race(
    venue_index: int, race_no: int
) -> tuple[RaceData, BankInfo | None, list[RacerHistoryEntry]]:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(user_agent=USER_AGENT, viewport={"width": 1280, "height": 2000})
        capture = JsonCapture(page)
        try:
            open_venue(page, venue_index)
            open_race(page, race_no)

            # 基本情報タブ（出走表本体）
            page.evaluate("document.querySelector('#rcbtn1')?.click()")
            basic = capture.wait_for("JSJ001")
            race = parse_basic_info(basic)
            jsj005 = capture.wait_for("JSJ005")
            parse_line_formation(race, jsj005)
            jsj006 = capture.wait_for("JSJ006")
            enrich_entries_with_stats(race, jsj006)
            _sleep()

            # オッズタブを開く（サイト自身がJST010/JST011等のJSONを発行する）
            page.evaluate("document.querySelector('#rcbtn6')?.click()")
            jst010 = capture.wait_for("JST010")
            enrich_entries_with_racer_attrs(race, jst010)
            jst011 = capture.wait_for("JST011")
            parse_odds_sanrentan(race, jst011)
            _sleep()

            # 結果タブ（レース終了前は結果が存在せずJSJ012が発行されないことがある）
            page.evaluate("document.querySelector('#rcbtn8')?.click()")
            try:
                jsj012 = capture.wait_for("JSJ012", timeout_sec=5.0)
                parse_results(race, jsj012)
            except RuntimeError:
                pass  # レース未終了などでまだ結果が無い
            _sleep()

            # バンク特性（開催場単位。ほぼ不変なので鮮度が十分ならスキップする）
            bank_age = _days_since_update(
                "SELECT updated_at FROM bank_info WHERE jocd=?", (race.jocd,)
            )
            bank_info = None
            if bank_age is None or bank_age > BANK_INFO_MAX_AGE_DAYS:
                bank_info = scrape_bank_info(page, race.jocd)

            # 選手ごとの直近成績（出走間隔・過去の同条件成績用。選手単位で鮮度チェック）
            histories: list[RacerHistoryEntry] = []
            for e in race.entries:
                snum = e["snum"]
                age = _days_since_update(
                    "SELECT MAX(scraped_at) FROM racer_race_history WHERE snum=?",
                    (snum,),
                )
                if age is not None and age <= RACER_HISTORY_MAX_AGE_DAYS:
                    continue
                histories.extend(scrape_racer_history(page, snum))

            return race, bank_info, histories
        finally:
            browser.close()


def save_to_db(
    race: RaceData,
    bank_info: BankInfo | None = None,
    histories: list[RacerHistoryEntry] | None = None,
) -> None:
    # 注: PythonのlibSQL HTTPクライアントは対話的トランザクション(tx.execute)を
    # サポートしていないため、race_idの確定(RETURNING)だけ単発execute、
    # 残りは1回のbatch()にまとめて送る（Turso側でbatchはまとめて処理される）。
    client = get_client()
    try:
        race_result = client.execute(
            """INSERT INTO races (kaisai_date, jocd, keirinjo_name, race_no, syumoku,
                                   grade_kbn, kyori, shukai, start_time, encp, tenki, husoku)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(kaisai_date, jocd, race_no) DO UPDATE SET
                   syumoku=excluded.syumoku, grade_kbn=excluded.grade_kbn,
                   kyori=excluded.kyori, shukai=excluded.shukai,
                   start_time=excluded.start_time, encp=excluded.encp,
                   tenki=excluded.tenki, husoku=excluded.husoku
               RETURNING id""",
            [race.kaisai_date, race.jocd, race.keirinjo_name, race.race_no, race.syumoku,
             race.grade_kbn, race.kyori, race.shukai, race.start_time, race.encp,
             race.tenki, race.husoku],
        )
        race_id = race_result.rows[0][0]

        statements: list[tuple[str, list]] = []

        for e in race.entries:
            statements.append((
                """INSERT INTO racers (snum, name, pref, class_rank, prev_class_rank, kyakushitsu,
                                        heikin_tokuten, syouritu, rentairitu2, rentairitu3,
                                        kimarite_nige_count, kimarite_makuri_count,
                                        kimarite_sashi_count, kimarite_mark_count,
                                        standing_count, home_lead_count, back_lead_count)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(snum) DO UPDATE SET
                       name=excluded.name, pref=excluded.pref,
                       class_rank=excluded.class_rank, prev_class_rank=excluded.prev_class_rank,
                       kyakushitsu=excluded.kyakushitsu,
                       heikin_tokuten=excluded.heikin_tokuten, syouritu=excluded.syouritu,
                       rentairitu2=excluded.rentairitu2, rentairitu3=excluded.rentairitu3,
                       kimarite_nige_count=COALESCE(excluded.kimarite_nige_count, racers.kimarite_nige_count),
                       kimarite_makuri_count=COALESCE(excluded.kimarite_makuri_count, racers.kimarite_makuri_count),
                       kimarite_sashi_count=COALESCE(excluded.kimarite_sashi_count, racers.kimarite_sashi_count),
                       kimarite_mark_count=COALESCE(excluded.kimarite_mark_count, racers.kimarite_mark_count),
                       standing_count=COALESCE(excluded.standing_count, racers.standing_count),
                       home_lead_count=COALESCE(excluded.home_lead_count, racers.home_lead_count),
                       back_lead_count=COALESCE(excluded.back_lead_count, racers.back_lead_count),
                       updated_at=datetime('now')""",
                [e["snum"], e["name"], e.get("pref"), e.get("class_rank"), e.get("prev_class_rank"),
                 e.get("kyakushitsu"), e.get("heikin_tokuten"), e.get("syouritu"),
                 e.get("rentairitu2"), e.get("rentairitu3"),
                 e.get("kimarite_nige_count"), e.get("kimarite_makuri_count"),
                 e.get("kimarite_sashi_count"), e.get("kimarite_mark_count"),
                 e.get("standing_count"), e.get("home_lead_count"), e.get("back_lead_count")],
            ))
            statements.append((
                """INSERT INTO entries (race_id, snum, car_num, line_group, line_position)
                   VALUES (?,?,?,?,?)
                   ON CONFLICT(race_id, car_num) DO UPDATE SET
                       snum=excluded.snum, line_group=excluded.line_group,
                       line_position=excluded.line_position""",
                [race_id, e["snum"], e["car_num"], e.get("line_group"), e.get("line_position")],
            ))

        for r in race.results:
            statements.append((
                """INSERT INTO results (race_id, snum, car_num, finish_pos, kimarite)
                   VALUES (?,?,?,?,?)
                   ON CONFLICT(race_id, car_num) DO UPDATE SET
                       finish_pos=excluded.finish_pos, kimarite=excluded.kimarite""",
                [race_id, r["snum"], r["car_num"], r["finish_pos"], r["kimarite"]],
            ))

        for o in race.odds:
            statements.append((
                """INSERT INTO odds (race_id, bet_type, combination, odds_value)
                   VALUES (?,?,?,?)""",
                [race_id, o["bet_type"], o["combination"], o["odds_value"]],
            ))

        if bank_info is not None:
            statements.append((
                """INSERT INTO bank_info (jocd, keirinjo_name, shuutyou, tyokusen, kant, tkant,
                                           home_hukuin, back_hukuin, center_hukuin,
                                           nige_pct, makuri_pct, sashi_pct, feature_text, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
                   ON CONFLICT(jocd) DO UPDATE SET
                       keirinjo_name=excluded.keirinjo_name, shuutyou=excluded.shuutyou,
                       tyokusen=excluded.tyokusen, kant=excluded.kant, tkant=excluded.tkant,
                       home_hukuin=excluded.home_hukuin, back_hukuin=excluded.back_hukuin,
                       center_hukuin=excluded.center_hukuin, nige_pct=excluded.nige_pct,
                       makuri_pct=excluded.makuri_pct, sashi_pct=excluded.sashi_pct,
                       feature_text=excluded.feature_text, updated_at=datetime('now')""",
                [bank_info.jocd, race.keirinjo_name, bank_info.shuutyou, bank_info.tyokusen,
                 bank_info.kant, bank_info.tkant, bank_info.home_hukuin, bank_info.back_hukuin,
                 bank_info.center_hukuin, bank_info.nige_pct, bank_info.makuri_pct,
                 bank_info.sashi_pct, bank_info.feature_text],
            ))

        for h in histories or []:
            statements.append((
                """INSERT INTO racer_race_history (snum, race_date, venue_abbr, finish_positions)
                   VALUES (?,?,?,?)
                   ON CONFLICT(snum, race_date, venue_abbr) DO UPDATE SET
                       finish_positions=excluded.finish_positions, scraped_at=datetime('now')""",
                [h.snum, h.race_date, h.venue_abbr, h.finish_positions],
            ))

        if statements:
            client.batch(statements)
    finally:
        client.close()


def resolve_venue_index_by_name(venue_name: str) -> int:
    """本日発売中の開催場一覧から、名前（部分一致）でインデックスを解決する。

    公式サイトの表示ラベルは「京王」のような略称のため、
    フルネーム（「京王閣」等）で渡された場合も互いの部分一致で照合する。
    """
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(user_agent=USER_AGENT)
        try:
            venues = list_today_venues(page)
        finally:
            browser.close()

    matches = [
        v for v in venues
        if venue_name in v["label"] or v["label"] in venue_name
    ]
    if not matches:
        today_list = ", ".join(f"{v['index']}:{v['label']}" for v in venues)
        raise RuntimeError(
            f"'{venue_name}' は本日発売中の開催場に見つかりません。本日の一覧: {today_list}"
        )
    if len(matches) > 1:
        candidates = ", ".join(f"{v['index']}:{v['label']}" for v in matches)
        raise RuntimeError(f"'{venue_name}' に複数の候補があり特定できません: {candidates}")
    return matches[0]["index"]


def main():
    parser = argparse.ArgumentParser(description="KEIRIN.JPから1レース分のデータを取得")
    parser.add_argument("--list-venues", action="store_true", help="本日発売中の開催場一覧を表示")
    parser.add_argument("--venue-index", type=int, help="開催場のインデックス（--list-venuesで確認）")
    parser.add_argument("--venue-name", type=str, help="開催場名（例: 京王閣）。--venue-indexの代わりに指定可")
    parser.add_argument("--race-no", type=int, help="レース番号")
    args = parser.parse_args()

    if args.list_venues:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(user_agent=USER_AGENT)
            for v in list_today_venues(page):
                print(f"{v['index']}: {v['label']}")
            browser.close()
        return

    venue_index = args.venue_index
    if venue_index is None and args.venue_name:
        venue_index = resolve_venue_index_by_name(args.venue_name)
        print(f"開催場名 '{args.venue_name}' → インデックス {venue_index} に解決しました")

    if venue_index is None or args.race_no is None:
        parser.print_help()
        return

    race, bank_info, histories = scrape_one_race(venue_index, args.race_no)
    print(f"取得: {race.keirinjo_name} {race.race_no}R ({race.kaisai_date}) "
          f"選手{len(race.entries)}名 / 結果{len(race.results)}件 / オッズ{len(race.odds)}件 / "
          f"バンク情報{'更新' if bank_info else 'キャッシュ利用'} / 選手履歴{len(histories)}件")
    save_to_db(race, bank_info, histories)
    print("DB保存完了（Turso）")


if __name__ == "__main__":
    main()
