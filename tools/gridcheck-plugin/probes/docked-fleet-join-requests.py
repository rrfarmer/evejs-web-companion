import blue
from utillib import KeyVal
from eve.client.script.ui.shared.fleet.fleetJoinRequestWnd import FleetJoinRequestWindow
from eve.client.script.ui.shared.fleet.fleetwindow import FleetWindow
import localization


def observe():
    fleet = sm.GetService('fleet')
    if session.fleetid or FleetJoinRequestWindow.GetIfOpen():
        raise RuntimeError('A fresh docked pilot is required')
    try:
        fleet.CreateFleet()
        for _ in range(40):
            if session.fleetid and session.charid in fleet.members:
                break
            blue.pyos.synchro.SleepWallclock(200)
        window = FleetWindow.Open()
        menu_label = localization.GetByLabel('UI/Fleet/FleetWindow/OpenJoinRequest')
        entry = next(item for item in window.GetFleetMenuTop() if item and item.GetText() == menu_label)
        fleet.OpenJoinRequestWindow()
        requests = FleetJoinRequestWindow.GetIfOpen()
        empty = len(requests.sr.scroll.GetNodes())
        chars = [140000002, 140000001]
        fleet.OnJoinRequestUpdate({char: KeyVal(charID=char) for char in chars})
        blue.pyos.synchro.SleepWallclock(350)
        requests = FleetJoinRequestWindow.GetIfOpen()
        nodes = requests.sr.scroll.GetNodes()
        buttons = [localization.GetByLabel(label) for label in ('UI/Fleet/AcceptJoinRequest', 'UI/Fleet/RejectJoinRequest')]
        result = dict(build=3698585, station=session.stationid, menu=entry.GetText(), caption=requests.GetCaption(),
                      help=requests.join_request.text, size=list(requests.GetAbsolute())[2:],
                      empty=empty, rows=[[node.charID, node.label] for node in nodes], buttons=buttons)
        fleet.OnJoinRequestUpdate({})
        result['cleared'] = len(FleetJoinRequestWindow.GetIfOpen().sr.scroll.GetNodes())
        return result
    finally:
        FleetJoinRequestWindow.CloseIfOpen()
        FleetWindow.CloseIfOpen()
        if session.fleetid:
            fleet.LeaveFleet()


result = observe()
