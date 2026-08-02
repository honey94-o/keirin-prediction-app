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
import datetime
import re
import time
import urllib.error
import urllib.request
from typing import Any

from bs4 import BeautifulSoup, Tag

from keirin_scraper import RaceData, save_to_db

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "keirin-prediction-app/0.1 (personal use, non-commercial backtest tool)"
)
REQUEST_INTERVAL_SEC = 1.5


def _sleep() -> None:
    time.sleep(REQUEST_INTERVAL_SEC)


def _get(url: str) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, ""


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
NAME_INFO_RE = re.compile(r"(SS|S1|S2|A1|A2|A3)\s*(\d+)歳\s*(\d+)期")
CYCLIST_ID_RE = re.compile(r"/keirin/cyclist/(\d+)")
BIB_NUM_RE = re.compile(r"(\d+)番")


def discover_cup_ids(venue: str, yyyymm: str) -> list[str]:
    """開催場の月間日程ページから、その月に実際に開催された開催ID(cupId)一覧を返す。"""
    status, html = _get(f"https://winticket.jp/keirin/{venue}/schedule/{yyyymm}")
    _sleep()
    if status != 200:
        return []
    ids = sorted(set(re.findall(rf"/keirin/{venue}/racecard/(\d+)", html)))
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
        }
        if car_num in line_info:
            entry["line_group"], entry["line_position"] = line_info[car_num]
        race.entries.append(entry)

    return race


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
        race.results.append({
            "car_num": car_num,
            "snum": snum,
            "finish_pos": int(finish_text),
            "kimarite": kimarite,
        })

    if len(tables) < 2:
        return
    payout_table = tables[1]
    for row in payout_table.find_all("tr"):
        cells = [c.get_text(" ", strip=True) for c in row.find_all(["th", "td"])]
        if len(cells) >= 3 and cells[0] == "3連単":
            combination = cells[1].replace("=", "-")
            payout_yen = _to_float(re.sub(r"[^\d.]", "", cells[2]))
            if payout_yen is not None:
                race.odds.append({
                    "bet_type": "3連単",
                    "combination": combination,
                    "odds_value": payout_yen / 100,
                })


def scrape_one_race(venue: str, cup_id: str, day: int, race_no: int) -> RaceData | None:
    status, html = _get(f"https://winticket.jp/keirin/{venue}/racecard/{cup_id}/{day}/{race_no}")
    _sleep()
    if status == 404:
        return None
    if status != 200:
        print(f"  警告: racecard取得失敗 status={status} {venue}/{cup_id}/{day}/{race_no}")
        return None
    race = parse_racecard(html, cup_id, day, race_no)
    if race is None or not race.entries:
        return None

    status, html = _get(f"https://winticket.jp/keirin/{venue}/raceresult/{cup_id}/{day}/{race_no}")
    _sleep()
    if status == 200:
        parse_raceresult(html, race)

    return race


def scrape_cup(venue: str, cup_id: str, max_days: int = 4, max_races: int = 12) -> list[RaceData]:
    races: list[RaceData] = []
    for day in range(1, max_days + 1):
        day_had_race = False
        for race_no in range(1, max_races + 1):
            race = scrape_one_race(venue, cup_id, day, race_no)
            if race is None:
                break  # この日はrace_no件で打ち止め（race_no==1なら開催なし）
            day_had_race = True
            races.append(race)
            print(f"  取得: {race.keirinjo_name} {race.race_no}R ({race.kaisai_date}) "
                  f"選手{len(race.entries)}名 / 結果{len(race.results)}件 / オッズ{len(race.odds)}件")
        if not day_had_race:
            break  # これ以上の日程はなし
    return races


ALL_VENUE_SLUGS = [
    "hakodate", "aomori", "iwakidaira", "yahiko", "maebashi", "toride", "utsunomiya",
    "omiya", "seibuen", "keiokaku", "tachikawa", "matsudo", "chiba", "kawasaki",
    "hiratsuka", "odawara", "ito", "shizuoka", "nagoya", "gifu", "ogaki", "toyohashi",
    "toyama", "matsusaka", "yokkaichi", "fukui", "nara", "mukomachi", "wakayama",
    "kishiwada", "tamano", "hiroshima", "hofu", "takamatsu", "komatsushima", "kochi",
    "matsuyama", "kokura", "kurume", "takeo", "sasebo", "beppu", "kumamoto",
]


def scrape_venue_recent(
    venue: str, since_date: datetime.date, on_race=None
) -> list[RaceData]:
    """指定開催場について、since_date以降に開始した開催(cup)を全て取得する。

    on_raceを渡すと、レースを1件取得するたびに呼び出す（中断されても
    それまでの取得分がDBに残るよう、逐次保存するために使う）。
    """
    months = sorted({
        since_date.strftime("%Y%m"),
        datetime.date.today().strftime("%Y%m"),
    })
    cup_ids: list[str] = []
    for yyyymm in months:
        cup_ids.extend(discover_cup_ids(venue, yyyymm))
    cup_ids = sorted(set(cup_ids))

    since_str = since_date.strftime("%Y%m%d")
    target_cups = [c for c in cup_ids if c[:8] >= since_str]

    all_races: list[RaceData] = []
    for cup_id in target_cups:
        print(f"開催 {venue}/{cup_id} を取得中...")
        cup_races = scrape_cup(venue, cup_id)
        for race in cup_races:
            if on_race is not None:
                on_race(race)
        all_races.extend(cup_races)
    return all_races


def main() -> None:
    parser = argparse.ArgumentParser(description="WINTICKETから過去レースを取得してTursoに保存する")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--venue", help="開催場のURLスラッグ（例: iwakidaira）")
    group.add_argument(
        "--all-venues", action="store_true", help="全43開催場を対象にする（節度あるアクセス間隔のため長時間かかる）"
    )
    parser.add_argument("--days-back", type=int, default=7, help="何日前まで遡るか（デフォルト7日）")
    args = parser.parse_args()

    since_date = datetime.date.today() - datetime.timedelta(days=args.days_back)
    venues = ALL_VENUE_SLUGS if args.all_venues else [args.venue]

    total = 0
    for venue in venues:
        print(f"=== {venue} ===")

        def save_one(race: RaceData) -> None:
            save_to_db(race, bank_info=None, histories=None)

        races = scrape_venue_recent(venue, since_date, on_race=save_one)
        print(f"{venue}: {len(races)}件保存")
        total += len(races)

    print(f"\n合計 {total} レースを保存しました（Turso）")


if __name__ == "__main__":
    main()
