import blue
from eve.client.script.parklife import fleetSvc
from eve.client.script.ui.shared.fleet.fleetwindow import FleetWindow
from localization import GetByLabel
from utillib import KeyVal


def observe():
    fleet = sm.GetService('fleet')
    if session.fleetid:
        raise RuntimeError('A fresh docked pilot is required')
    setup_name = 'Codex Store'
    if setup_name in fleet.GetFleetSetups():
        raise RuntimeError('The fixture setup already exists')
    original_window = fleetSvc.StoreFleetSetupWnd
    captured = []

    class CaptureModal(object):
        def __init__(self, **attributes):
            self.window = original_window(**attributes)
            self.info = attributes['currentFleetInfo']
            self.result = None

        def ShowModal(self):
            window = self.window
            try:
                blue.pyos.synchro.SleepWallclock(250)
                controls = [window.motdCb, window.freeMoveCb, window.maxFleetSizeCb, window.defaultSquadCb]
                captured.append(dict(caption=window.GetCaption(), size=list(window.GetAbsolute())[2:],
                                     defaults=[bool(cb.GetValue()) if cb is not None else None for cb in controls],
                                     emptyName=window.newName.GetValue(), motd=self.info.currentMotd,
                                     maxSize=self.info.currentMaxSize, defaultSquad=self.info.currentDefaultSquadName))
                if len(captured) == 1:
                    return 0
                self.result = KeyVal(setupName=setup_name, storeMotd=True, storeFreeMove=True,
                                     storeDefaultSquad=True, storeMaxSize=True)
                return 1
            finally:
                window.Close()

    try:
        fleet.CreateFleet()
        for _ in range(40):
            if session.fleetid and session.charid in fleet.members:
                break
            blue.pyos.synchro.SleepWallclock(200)
        window = FleetWindow.Open()
        label = GetByLabel('UI/Fleet/FleetWindow/StoreFleetSetup')
        action = next(item for item in window.GetFleetMenuTop() if item and item.GetText() == label)
        wing = fleet.GetWings().values()[0]
        squad = wing.squads.values()[0]
        fleet.fleet.ChangeWingName(wing.wingID, 'Codex Wing')
        fleet.fleet.ChangeSquadName(squad.squadID, 'Codex Sq')
        fleet.SetRemoteMotd('Codex setup MOTD')
        fleet.fleet.SetFleetMaxSize(17)
        fleet.SetOptions(isFreeMove=True)
        fleet.SetAutoJoinSquadID(squad.squadID)
        blue.pyos.synchro.SleepWallclock(500)
        fleetSvc.StoreFleetSetupWnd = CaptureModal
        fleet.StoreSetup()
        cancelled = setup_name not in fleet.GetFleetSetups()
        fleet.StoreSetup()
        stored = fleet.GetFleetSetups().get(setup_name)
        return dict(build=3698585, station=session.stationid, label=action.GetText(), cancelled=cancelled,
                    windows=captured, stored=stored, yaml=fleet.characterSettings.Get('fleetSetups'))
    finally:
        fleetSvc.StoreFleetSetupWnd = original_window
        fleet.DeleteFleetSetup(setup_name)
        FleetWindow.CloseIfOpen()
        if session.fleetid:
            fleet.LeaveFleet()


result = observe()
