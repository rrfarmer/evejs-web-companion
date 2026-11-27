import blue
from eveexceptions import UserError
from eve.client.script.ui.shared.fleet.fleetConst import FLEET_BROADCASTS_VISIBLE_SETTING
from eve.client.script.ui.shared.fleet.fleetbroadcastexports import fleetBroadcastScopeSetting
from eve.client.script.ui.shared.fleet.fleetwindow import (
    FleetWindow, PANEL_BROADCASTS, PANEL_FLEETFINDER, PANEL_MYFLEET, PANEL_RESPAWN)
from eve.client.script.ui.shared.pointerTool import pointerToolConst as names, pointerToolUtil
from eve.client.script.ui.shared.pointerTool.pointerChains import FindChainForPointer
from eve.client.script.ui.shared.pointerTool.pointerToolFunctions import GetScreenElementsByUniqueName
from localization import GetByLabel


def observe():
    ids = (names.UNIQUE_NAME_FLEET_FINDER_TAB, names.UNIQUE_NAME_FLEET_FINDER_SETTINGS,
           names.UNIQUE_NAME_FLEET_MY_FLEET_TAB, names.UNIQUE_NAME_FLEET_HISTORY_TAB,
           names.UNIQUE_NAME_FLEET_HISTORY_FILTER, names.UNIQUE_NAME_FLEET_ACTIVE_RECLONERS_TAB,
           names.UNIQUE_NAME_FLEET_SETTINGS, names.UNIQUE_NAME_FLEET_SHOW_BROADCASTS,
           names.UNIQUE_NAME_FLEET_BROADCAST_ICONS, names.UNIQUE_NAME_FLEET_BROADCAST_SCOPE,
           names.UNIQUE_NAME_BROADCAST_ARMOR, names.UNIQUE_NAME_BROADCAST_SHIELD)
    groups = pointerToolUtil.GetFilteredScrollList('', None, names.SOURCE_LOCATION_WINDOW)
    group = next(row for row in groups if row.label == GetByLabel('UI/Help/PointerWndUiElements'))
    catalogue = [dict(name=row.uiElementName, label=row.label,
                      texture=row.texturePath or (row.iconData.resolve(16) if row.iconData else None),
                      chain=FindChainForPointer(row.uiElementName))
                 for row in group.GetSubContent(group) if row.uiElementName in ids]

    def sample(window, tab):
        window.tabGroup.ShowPanelByID(tab)
        blue.pyos.synchro.SleepWallclock(450)
        return dict((name, list(element.GetAbsolute()))
                    for name, element in GetScreenElementsByUniqueName(ids).iteritems()
                    if element and not element.destroyed and element.display)

    def menu_entries(entries):
        return [dict(label=entry.GetText(), enabled=entry.IsEnabled(),
                     submenu=menu_entries(entry.GetSubMenuData()) if entry.HasSubMenuData() else [])
                for entry in entries if entry is not None]

    if session.fleetid or FleetWindow.GetIfOpen():
        raise RuntimeError('A fresh docked pilot is required')
    fleet = sm.GetService('fleet')
    old_visibility = FLEET_BROADCASTS_VISIBLE_SETTING.get()
    old_scope = fleetBroadcastScopeSetting.get()
    try:
        window = FleetWindow.Open()
        finder_solo = sample(window, PANEL_FLEETFINDER)
        solo_menu = menu_entries(window.GetMenuMoreOptions().GetEntries())
        window.Close()
        fleet.CreateFleet()
        for attempt in range(35):
            if session.fleetid:
                break
            blue.pyos.synchro.SleepWallclock(200)
        if not session.fleetid:
            raise RuntimeError('The docked pilot did not enter a fleet')
        window = FleetWindow.Open()
        FLEET_BROADCASTS_VISIBLE_SETTING.set(False)
        window.broadcastCont.UpdateBroadcastButtonState()
        roster = sample(window, PANEL_MYFLEET)
        fleet_menu = menu_entries(window.GetMenuMoreOptions().GetEntries())
        bar = window.broadcastCont
        bar.ToggleBroadcasts()
        collapsed = sample(window, PANEL_MYFLEET)
        bar.ToggleBroadcasts()
        expanded = sample(window, PANEL_MYFLEET)
        fleetBroadcastScopeSetting.set(3)
        scopes = [fleet.broadcastScope]
        for _ in range(3):
            bar.CycleBroadcastScope()
            scopes.append(fleet.broadcastScope)
        refusals = {}
        for name in ('HealArmor', 'HealShield'):
            try:
                fleet.SendBroadcast(name)
            except UserError as err:
                refusals[name] = err.msg
        return dict(build=3698585, station=session.stationid, catalogue=catalogue,
                    solo=finder_solo, roster=roster, collapsed=collapsed, expanded=expanded,
                    scopes=scopes, refusals=refusals,
                    soloMenu=solo_menu, fleetMenu=fleet_menu,
                    finder=sample(window, PANEL_FLEETFINDER),
                    broadcasts=sample(window, PANEL_BROADCASTS),
                    respawn=sample(window, PANEL_RESPAWN))
    finally:
        FLEET_BROADCASTS_VISIBLE_SETTING.set(old_visibility)
        fleetBroadcastScopeSetting.set(old_scope)
        window = FleetWindow.GetIfOpen()
        if window:
            window.Close()
        if session.fleetid:
            fleet.LeaveFleet()


result = observe()
