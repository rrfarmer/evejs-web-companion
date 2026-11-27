import blue
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

    if session.fleetid or FleetWindow.GetIfOpen():
        raise RuntimeError('A fresh docked pilot is required')
    fleet = sm.GetService('fleet')
    try:
        window = FleetWindow.Open()
        finder_solo = sample(window, PANEL_FLEETFINDER)
        window.Close()
        fleet.CreateFleet()
        for attempt in range(35):
            if session.fleetid:
                break
            blue.pyos.synchro.SleepWallclock(200)
        if not session.fleetid:
            raise RuntimeError('The docked pilot did not enter a fleet')
        window = FleetWindow.Open()
        return dict(build=3698585, station=session.stationid, catalogue=catalogue,
                    solo=finder_solo, roster=sample(window, PANEL_MYFLEET),
                    finder=sample(window, PANEL_FLEETFINDER),
                    broadcasts=sample(window, PANEL_BROADCASTS),
                    respawn=sample(window, PANEL_RESPAWN))
    finally:
        window = FleetWindow.GetIfOpen()
        if window:
            window.Close()
        if session.fleetid:
            fleet.LeaveFleet()


result = observe()
