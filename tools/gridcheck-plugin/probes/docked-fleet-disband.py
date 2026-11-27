import blue
from carbonui import const as uiconst
import localization
from eve.client.script.ui.shared.fleet import fleetwindow


def observe():
    fleet = sm.GetService('fleet')
    if session.fleetid:
        raise RuntimeError('A fresh docked pilot is required')
    original = fleetwindow.prompt_player_fsd_dialog
    dialogs = []
    answer = [uiconst.ID_NO]

    def record(name, values, buttons):
        dialogs.append([name, buttons == uiconst.YESNO])
        return answer[0]

    try:
        window = fleetwindow.FleetWindow.Open()
        label = localization.GetByLabel('UI/Fleet/DisbandFleet')
        has_action = lambda: any(item and item.GetText() == label for item in window.GetFleetMenuTop())
        fleetless_action = has_action()
        fleet.CreateFleet()
        for _ in range(40):
            if session.fleetid and session.charid in fleet.members:
                break
            blue.pyos.synchro.SleepWallclock(200)
        window = fleetwindow.FleetWindow.Open()
        fleet_id = session.fleetid
        if fleet_id is None or not has_action():
            raise RuntimeError('Boss fleet and disband action required')
        fleetwindow.prompt_player_fsd_dialog = record
        window.DisbandFleet()
        after_no = session.fleetid
        answer[0] = uiconst.ID_YES
        window.DisbandFleet()
        for _ in range(40):
            if session.fleetid is None:
                break
            blue.pyos.synchro.SleepWallclock(200)
        return dict(build=3698585, station=session.stationid, label=label, fleetlessAction=fleetless_action,
                    dialogs=dialogs, fleetID=fleet_id, afterNo=after_no, afterYes=session.fleetid)
    finally:
        fleetwindow.prompt_player_fsd_dialog = original
        fleetwindow.FleetWindow.CloseIfOpen()
        if session.fleetid:
            fleet.LeaveFleet()


result = observe()
