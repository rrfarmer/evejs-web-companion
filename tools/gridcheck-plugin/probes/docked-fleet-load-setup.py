import blue
import json
from eve.client.script.parklife import fleetSvc
from eve.client.script.ui.shared.fleet.fleetwindow import FleetWindow
from localization import GetByLabel


def observe():
    fleet = sm.GetService('fleet')
    if session.fleetid:
        raise RuntimeError('A fresh docked pilot is required')
    setups = fleet.GetFleetSetups()
    name = 'Codex Load'
    if name in setups:
        raise RuntimeError('The fixture setup already exists')
    original = fleet.characterSettings.Get('fleetSetups')
    prompt = fleetSvc.prompt_player_fsd_dialog
    notices = []
    setup = dict(setupName=name, motd='Codex loaded MOTD', isFreeMove=True, maxFleetSize=19,
                 defaultSquad=['Load Wing', 1, 'Backup'],
                 wingsInfo={'load wing': dict(wingName='Load Wing', wingIdx=0, squadNames=['Primary', 'Backup'])})
    try:
        setups[name] = setup
        fleet.characterSettings.Save('fleetSetups', json.dumps(list(setups.values())))
        fleet.CreateFleet()
        for _ in range(40):
            if session.fleetid and session.charid in fleet.members:
                break
            blue.pyos.synchro.SleepWallclock(200)
        window = FleetWindow.Open()
        menu = GetByLabel('UI/Fleet/FleetWindow/FleetSetups')
        overview = GetByLabel('UI/Fleet/FleetWindow/SetupsOverview')
        labels = [item.GetText() for item in window.GetFleetMenuTop() if item]
        listed = [item.GetText() for item in window.GetFleetSetups() if item]
        fleetSvc.prompt_player_fsd_dialog = lambda dialog, *args, **kwargs: notices.append(dialog)
        fleet.LoadSetup(name)
        for _ in range(35):
            if fleet.GetAutoJoinSquadID() and fleet.options.isFreeMove:
                break
            blue.pyos.synchro.SleepWallclock(200)
        wings = sorted(fleet.GetWings().values(), key=lambda wing: wing.wingID)
        squads = [[s.name, s.squadID] for w in wings for s in sorted(w.squads.values(), key=lambda squad: squad.squadID)]
        return dict(build=3698585, station=session.stationid, menu=menu, overview=overview, listed=listed,
                    visible=menu in labels, notices=notices, wings=[w.name for w in wings], squads=squads,
                    defaultSquad=fleet.GetAutoJoinSquadID(), freeMove=bool(fleet.options.isFreeMove),
                    maxSize=fleet.fleet.GetFleetMaxSize(), motd=fleet.GetMotd(), lastLoaded=fleet.lastLoadedSetup)
    finally:
        fleetSvc.prompt_player_fsd_dialog = prompt
        setups.pop(name, None)
        fleet.characterSettings.Save('fleetSetups', original)
        FleetWindow.CloseIfOpen()
        if session.fleetid:
            fleet.LeaveFleet()


result = observe()
