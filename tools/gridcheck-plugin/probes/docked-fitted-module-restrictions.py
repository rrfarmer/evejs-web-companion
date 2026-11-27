from evedungeons.client.data import GetDungeons
from evelink.client.handlers.local_service.handler import handle_local_service_link
from eve.client.script.ui.control.typeList.type_list_window import TypeListWindow
import localization


def observe_window(dungeon_id):
    if TypeListWindow.GetIfOpen():
        raise RuntimeError('The type list window is already open')
    base = 'UI/Agents/Dialogue/DungeonDisallowedFittedTypesRestrictions'
    try:
        handle_local_service_link('localsvc:method=PopupDungeonFittedTypesRestrictionList&dungeonID=%d' % dungeon_id)
        window = TypeListWindow.GetIfOpen()
        if not window:
            raise RuntimeError('The fitted-module link did not open a type list')
        return dict(caption=window.GetCaption(), header=window._header_text, info=window._info_text,
                    nativeLabel=localization.GetByLabel(base + 'Caption'),
                    dimensions=[window.default_width, window.default_height],
                    minimum=list(window.default_minSize),
                    groups={group: sorted(types) for group, types in window._types_by_group.items()},
                    searchHint=localization.GetByLabel('UI/Common/Search'))
    finally:
        window = TypeListWindow.GetIfOpen()
        if window:
            window.Close()


def observe():
    dungeons = GetDungeons()
    connected = 0
    connections = 0
    unknown = 0
    fitted_lists = []
    for dungeon_id, dungeon in dungeons.iteritems():
        if dungeon.connections:
            connected += 1
        for connection in dungeon.connections or ():
            connections += 1
            if not hasattr(connection, 'disallowedFittedTypesList'):
                unknown += 1
                continue
            list_id = connection.disallowedFittedTypesList
            if list_id:
                fitted_lists.append([dungeon_id, connection.fromObjectID, list_id])
    return dict(build=3698585, station=session.stationid, dungeons=len(dungeons),
                connected=connected, connections=connections, unknown=unknown,
                fittedLists=sorted(fitted_lists), window=observe_window(9596))


result = observe()
