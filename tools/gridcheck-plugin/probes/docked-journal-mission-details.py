import blue
import re
from eve.client.script.ui.station.agents import agents as agents_module
from eve.client.script.ui.station.agents.agentDialogueUtil import GetMissionDetailsWindowHTML, _ProcessDungeonData
from eve.client.script.ui.station.agents.missionDetailsWindow import MissionDetailsWindow
from eve.client.script.ui.shared.maps.starMapSvc import GetCharUiSetting, SetCharUiSetting
from evelink.client.handlers.show_info.parse import parse_show_info_url
from evelink.client.handlers.local_service.handler import handle_local_service_link
from evedungeons.client.ship_restrictions_window import ShipRestrictionsWindow
from evedungeons.client.util import GetDungeonShipRestrictionsTypeListID
from evedungeons.client.data import GetDungeon
import localization


def bookmark_menu(url):
    parsed = parse_show_info_url(url)
    bookmark = parsed.bookmark_info
    entries = []
    for entry in sm.GetService('link').get_menu(url):
        if entry is None:
            continue
        if hasattr(entry, 'GetLabelPath'):
            entries.append(dict(path=entry.GetLabelPath(), text=entry.GetText()))
        else:
            caption = entry[0]
            entries.append(dict(path=getattr(caption, 'labelPath', None),
                                text=caption.GetText() if hasattr(caption, 'GetText') else caption))
    return dict(url=url, system=bookmark.locationID, deadspace=bool(bookmark.deadspace),
                agent=bookmark.agentID, locationNumber=bookmark.locationNumber, entries=entries)


def bookmark_route_menus(url):
    key = 'autopilot_waypoints'
    original = GetCharUiSetting(key, [])
    remote = 30000142 if session.solarsystemid2 != 30000142 else 30000139
    second = 30000139 if remote == 30000142 else 30000142
    parts = url.split('//')
    local_parts = parts[:]
    local_parts[1] = str(session.solarsystemid2)
    parts[1] = str(remote)
    local_url, remote_url = '//'.join(local_parts), '//'.join(parts)
    try:
        SetCharUiSetting(key, [])
        near = bookmark_menu(local_url)
        empty = bookmark_menu(remote_url)
        SetCharUiSetting(key, [second, remote])
        destination = bookmark_menu(remote_url)
        SetCharUiSetting(key, [remote, second])
        earlier = bookmark_menu(remote_url)
        return dict(local=near, remote=empty, destination=destination, earlier=earlier)
    finally:
        SetCharUiSetting(key, original)


def ship_restriction_window(mission, agent_id, dungeon_id):
    dungeons = mission['objectives'].get('dungeons', [])
    if not dungeons:
        return None
    dungeon = next((one for one in dungeons
                    if one.get('dungeonID') == dungeon_id and one.get('shipRestrictions') == 1), None)
    measured_on_mission = dungeon is not None
    if not measured_on_mission:
        dungeon = dict(dungeons[0], dungeonID=dungeon_id)

    def notice(state):
        html = _ProcessDungeonData(dict(dungeon, shipRestrictions=state), agent_id)
        marker = html.index('localsvc:method=PopupDungeonShipRestrictionList')
        return html[html.rfind('\n', 0, marker) + 1:html.index('<br>', marker)]

    special = notice(1)
    link = re.search(r'href=(localsvc:[^>]+)', special).group(1)
    existing = ShipRestrictionsWindow.GetIfOpen()
    if existing:
        raise RuntimeError('A Ship Restrictions window is already open')
    try:
        handle_local_service_link(link)
        window = ShipRestrictionsWindow.GetIfOpen()
        if not window or window._dungeon_id != dungeon_id:
            raise RuntimeError('The mission link did not open the dungeon restrictions window')
        types = sorted({type_id for group in window._types_by_group.values() for type_id in group})
        return dict(dungeon=dungeon_id, gate=window._gate_id, measuredOnMission=measured_on_mission,
                    normal=notice(0), special=special, caption=window.GetCaption(),
                    header=localization.GetByMessageID(GetDungeon(dungeon_id).dungeonNameID),
                    typeList=GetDungeonShipRestrictionsTypeListID(dungeon_id), allowed=types)
    finally:
        window = ShipRestrictionsWindow.GetIfOpen()
        if window:
            window.Close()


def observe():
    svc = sm.GetService('agents')
    journal = sm.GetService('journal')
    agent_id = 3012018
    existing = next((row for row in journal.GetMyAgentJournalDetails()[0] if row[4] == agent_id), None)
    original = agents_module.are_missions_in_job_board_available
    try:
        agents_module.are_missions_in_job_board_available = lambda: False
        if existing is None:
            svc.OpenDialogueWindow(agent_id)
        mission = None
        for _ in range(55):
            mission = svc.GetMissionInfo(agent_id)
            if mission:
                break
            blue.pyos.synchro.SleepWallclock(200)
        if not mission:
            raise RuntimeError('No mission available from local agent')
        svc.PopupMission(agent_id)
        for _ in range(30):
            wnd = svc.missionDetailsWindows.get(agent_id)
            if wnd and wnd.agentID == agent_id:
                break
            blue.pyos.synchro.SleepWallclock(100)
        html = GetMissionDetailsWindowHTML(mission, agent_id)
        links = re.findall(r'<a href=["\']?(showinfo:[^"\'\s>]+)["\']?>(.*?)</a>', html, re.I | re.S)
        dungeon_links = [url for url, _ in links if url.endswith('//dungeon')]
        colors = re.findall(r'<font\s+color\s*=\s*["\']?(#[0-9a-f]{6}|0x[0-9a-f]{8})["\']?>(.*?)</font>', html, re.I | re.S)
        bold = re.findall(r'<b>(.*?)</b>', html, re.I | re.S)
        return dict(build=3698585, station=session.stationid, agent=agent_id,
                    title=wnd.GetCaption(), dimensions=[MissionDetailsWindow.default_width, MissionDetailsWindow.default_height],
                    minimum=list(MissionDetailsWindow.default_minSize), missionState=mission['missionState'],
                    fields=sorted(mission.keys()), html=html[:8000],
                    links=[dict(url=url, text=re.sub(r'<[^>]*>', '', body).strip(),
                                image=body.startswith('<img')) for url, body in links],
                    bookmarkMenus=[bookmark_menu(url) for url in dungeon_links],
                    bookmarkRouteMenus=bookmark_route_menus(dungeon_links[0]) if dungeon_links else None,
                    shipRestrictions=[ship_restriction_window(mission, agent_id, dungeon_id)
                                      for dungeon_id in (841, 2493)],
                    colors=[dict(color=color, text=re.sub(r'<[^>]*>', '', text).strip())
                            for color, text in colors if text],
                    bold=bold)
    finally:
        agents_module.are_missions_in_job_board_available = original
        if agent_id in svc.missionDetailsWindows:
            svc.missionDetailsWindows[agent_id].Close()
        if existing is None:
            try:
                svc.RemoveOfferFromJournal(agent_id)
            except Exception:
                pass


result = observe()
