import blue
import re
from carbonui.control.contextMenu.menuDataFactory import CreateMenuDataFromRawTuples
from carbonui.uicore import uicore
from eve.client.script.ui.shared.maps.browserwindow import MapBrowserWnd

TRAVEL = 'UI/Fleet/FleetBroadcast/Commands/BroadcastTravelTo'


def wait_for(predicate):
    for _ in range(70):
        if predicate():
            return
        blue.pyos.synchro.SleepWallclock(150)
    raise RuntimeError('Reference session did not reach the expected state')


def read_menu(chart, item_id, run=False):
    original = chart.GetPick
    try:
        chart.GetPick = lambda: [item_id]
        entries = [row for row in CreateMenuDataFromRawTuples(chart.GetMenu()).GetEntries()
                   if row is not None and row.GetLabelPath()]
        travel = next((row for row in entries if row.GetLabelPath() == TRAVEL), None)
        refusal = None
        if run and travel:
            try:
                travel.ExecuteFunction()
            except UserError as error:
                refusal = error.msg
        return dict(itemID=item_id, menu=[row.GetText() for row in entries], refusal=refusal)
    finally:
        chart.GetPick = original


def observe():
    if MapBrowserWnd.GetIfOpen() or session.fleetid or not session.stationid:
        raise RuntimeError('Use a fleetless NPC-docked pilot with the Map Browser closed')
    slash = sm.RemoteSvc('slash')
    fleet = sm.GetService('fleet')
    original_station = session.stationid
    system_id = session.solarsystemid2
    previous_abstract = settings.user.ui.Get('solarsystemmapabstract', 0)
    structure_id = None
    targets = (40009229, 40009230, 40009232, 50002183, 60003754)
    try:
        seeded = str(slash.SlashCmd('/upwell seed astrahus CodexMapBrowser13806'))
        match = re.search(r'(?<!\d)\d{10,}(?!\d)', seeded)
        if not match:
            raise RuntimeError('Could not seed the Upwell fixture: ' + seeded)
        structure_id = long(match.group(0))
        slash.SlashCmd('/tr me %d' % structure_id)
        wait_for(lambda: session.structureid == structure_id)

        settings.user.ui.Set('solarsystemmapabstract', 0)
        uicore.cmd.OpenMapBrowser(system_id)
        def map_ready():
            window = MapBrowserWnd.GetIfOpen()
            return window and len(window.sr.browser.children) == 4 and not window.sr.browser.loadingMap
        wait_for(map_ready)
        window = MapBrowserWnd.GetIfOpen()
        chart = next(child for child in window.sr.browser.children[3].children if getattr(child, 'drawlevel', None) == 4)
        marker_ids = [row.itemID for row in chart.mapitems if row.itemID in chart.cordsAsPortion]
        before = [read_menu(chart, item_id) for item_id in targets if item_id in marker_ids]
        fleet.CreateFleet()
        wait_for(lambda: session.fleetid and session.charid in fleet.members)
        during = [read_menu(chart, item_id, run=True) for item_id in targets if item_id in marker_ids]
        return dict(build=3698585, station=original_station, system=system_id, structureID=structure_id,
                    fleetID=session.fleetid, structureMarker=structure_id in marker_ids, before=before, during=during)
    finally:
        window = MapBrowserWnd.GetIfOpen()
        if window:
            window.Close()
        settings.user.ui.Set('solarsystemmapabstract', previous_abstract)
        if session.fleetid:
            fleet.LeaveFleet()
        if structure_id:
            slash.SlashCmd('/tr me %d' % original_station)
            wait_for(lambda: session.stationid == original_station)
            slash.SlashCmd('/upwell remove %d' % structure_id)


result = observe()
