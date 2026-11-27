import blue
import json
from eve.client.script.ui.shared.fleet import panelFormFleet
from eve.client.script.ui.shared.fleet.fleetwindow import FleetWindow
from localization import GetByLabel


def observe():
    fleet = sm.GetService('fleet')
    if session.fleetid:
        raise RuntimeError('A fresh docked pilot is required')
    original_setups = dict(fleet.GetFleetSetups())
    original = fleet.characterSettings.Get('fleetSetups')
    alpha = 'alpha Ops'
    zulu = 'Zulu Ops'
    fixtures = [
     dict(setupName=zulu, motd='Zulu formation', maxFleetSize=27, isFreeMove=False,
          defaultSquad=['Zulu Wing', 0, 'Zulu Squad'],
          wingsInfo={'zulu wing': dict(wingName='Zulu Wing', wingIdx=0, squadNames=['Zulu Squad'])}),
     dict(setupName=alpha, motd='Alpha formation', maxFleetSize=23, isFreeMove=True,
          defaultSquad=['Alpha Wing', 1, 'Reserve'],
          wingsInfo={'alpha wing': dict(wingName='Alpha Wing', wingIdx=0, squadNames=['Primary', 'Reserve'])})]

    def formed():
        for _ in range(40):
            if session.fleetid and session.charid in fleet.members:
                break
            blue.pyos.synchro.SleepWallclock(200)
        wings = sorted(fleet.GetWings().values(), key=lambda wing: wing.wingID)
        squads = [s for wing in wings for s in sorted(wing.squads.values(), key=lambda squad: squad.squadID)]
        default = next((s.name for s in squads if s.squadID == fleet.GetAutoJoinSquadID()), None)
        return dict(id=session.fleetid, wings=[w.name for w in wings], squads=[s.name for s in squads],
                    defaultSquad=default, motd=fleet.GetMotd(), freeMove=bool(fleet.options.isFreeMove),
                    maxSize=fleet.fleet.GetFleetMaxSize(), lastLoaded=fleet.lastLoadedSetup)

    try:
        fleet.characterSettings.Save('fleetSetups', json.dumps([]))
        fleet.fleetSetupsByName = {}
        window = FleetWindow.Open()
        setup_label = GetByLabel('UI/Fleet/FleetWindow/FormFleetWithSetup')
        empty_has_menu = any(item and item.GetText() == setup_label for item in window.GetFleetMenuTop())
        fleet.characterSettings.Save('fleetSetups', json.dumps(fixtures))
        fleet.fleetSetupsByName = {row['setupName']: row for row in fixtures}
        FleetWindow.CloseIfOpen()
        window = FleetWindow.Open()
        panel = window.tabGroup.GetTabs()[0].sr.panel
        setup_options = panelFormFleet.get_fleet_setup_options()
        options = [[option[0], option[1]] if isinstance(option, tuple) else [option.label, option.returnValue] for option in setup_options]
        initial = panel._setup_choice.GetValue()
        panel._setup_choice.SelectItemByValue(alpha)
        panel._form_fleet()
        combo_result = formed()
        fleet.LeaveFleet()
        for _ in range(40):
            if session.fleetid is None and fleet.fleet is None:
                break
            blue.pyos.synchro.SleepWallclock(200)
        window = FleetWindow.Open()
        entry = next(item for item in window.GetFleetMenuTop() if item and item.GetText() == setup_label)
        submenu = [item for item in entry.GetSubMenuData() if item]
        next(item for item in submenu if item.GetText() == zulu).ExecuteFunction()
        return dict(build=3698585, station=session.stationid, menu=setup_label, noSetupsMenu=empty_has_menu,
                    initial=initial, options=options, submenu=[item.GetText() for item in submenu],
                    combo=combo_result, fromMenu=formed())
    finally:
        if session.fleetid:
            fleet.LeaveFleet()
        fleet.characterSettings.Save('fleetSetups', original)
        fleet.fleetSetupsByName = original_setups
        FleetWindow.CloseIfOpen()


result = observe()
