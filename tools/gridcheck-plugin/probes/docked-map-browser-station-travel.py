import blue
from carbonui.control.contextMenu.menuDataFactory import CreateMenuDataFromRawTuples
from carbonui.uicore import uicore
from eve.client.script.ui.shared.maps.browserwindow import MapBrowserWnd

TRAVEL = 'UI/Fleet/FleetBroadcast/Commands/BroadcastTravelTo'


def read_menu(chart, item_id, run=False):
    original = chart.GetPick
    try:
        chart.GetPick = lambda: [item_id]
        entries = CreateMenuDataFromRawTuples(chart.GetMenu()).GetEntries()
        entries = [row for row in entries if row is not None and row.GetLabelPath()]
        travel = next((row for row in entries if row.GetLabelPath() == TRAVEL), None)
        refusal = None
        if run and travel:
            try:
                travel.ExecuteFunction()
            except UserError as error:
                refusal = error.msg
        return dict(itemID=item_id, paths=[row.GetLabelPath() for row in entries],
                    menu=[row.GetText() for row in entries],
                    label=travel.GetText() if travel else None, refusal=refusal)
    finally:
        chart.GetPick = original


def observe():
    if MapBrowserWnd.GetIfOpen() or session.fleetid:
        raise RuntimeError('Use a fleetless reference pilot with the Map Browser closed')
    fleet = sm.GetService('fleet')
    station_id = session.stationid
    targets = (station_id, 60000358, 40009230)
    try:
        uicore.cmd.OpenMapBrowser(session.solarsystemid2)
        for _ in range(80):
            window = MapBrowserWnd.GetIfOpen()
            if window and len(window.sr.browser.children) == 4 and not window.sr.browser.loadingMap:
                break
            blue.pyos.synchro.SleepWallclock(100)
        else:
            raise RuntimeError('Map Browser did not finish loading')
        chart = next(child for child in window.sr.browser.children[3].children if getattr(child, 'drawlevel', None) == 4)
        before = [read_menu(chart, item_id) for item_id in targets]
        fleet.CreateFleet()
        for _ in range(50):
            if session.fleetid and session.charid in fleet.members:
                break
            blue.pyos.synchro.SleepWallclock(200)
        else:
            raise RuntimeError('The fleet did not form')
        during = [read_menu(chart, item_id, run=True) for item_id in targets]
        return dict(build=3698585, station=station_id, fleetID=session.fleetid, before=before, during=during,
                    oldStationCount=len(cfg.oldStations))
    finally:
        window = MapBrowserWnd.GetIfOpen()
        if window:
            window.Close()
        if session.fleetid:
            fleet.LeaveFleet()


result = observe()
