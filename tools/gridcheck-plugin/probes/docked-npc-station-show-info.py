import blue
import evetypes
from eve.client.script.ui.shared.info.infoConst import (
    DATA_BUTTONS, TAB_ATTIBUTES, TAB_DESCRIPTION, TAB_JUMPS, TAB_LOCATION, TAB_ORBITALBODIES, TAB_SERVICES
)


def observe_window(info, item_id, type_id):
    window = info.ShowInfo(type_id, item_id, parentID=session.solarsystemid2, new=1)
    try:
        for _ in range(70):
            content = getattr(window, 'info_content', None)
            if content and hasattr(content, 'data') and not window.isLoading:
                break
            blue.pyos.synchro.SleepWallclock(100)
        else:
            raise RuntimeError('Show Info did not finish loading for %s' % item_id)

        def entries(tab):
            group = content.data.get(tab, {})
            return [dict(label=getattr(node, 'label', None), text=getattr(node, 'text', None),
                         id=getattr(node, 'itemID', None), typeID=getattr(node, 'typeID', None))
                    for node in group.get('items', [])]

        return dict(itemID=item_id, typeID=type_id, groupID=evetypes.GetGroupID(type_id),
                    name=cfg.evelocations.Get(item_id).locationName, caption=window.GetCaption(),
                    header=content.captionText, description=content.data[TAB_DESCRIPTION].get('text', ''),
                    dynamicTabs=list(content.dynamicTabs),
                    attributes=entries(TAB_ATTIBUTES), jumps=entries(TAB_JUMPS),
                    orbitals=entries(TAB_ORBITALBODIES), location=entries(TAB_LOCATION),
                    services=entries(TAB_SERVICES), actions=[entry[0] for entry in content.data.get(DATA_BUTTONS, []) or []])
    finally:
        window.Close()


def observe():
    info = sm.GetService('info')
    return dict(build=3698585, station=session.stationid, system=session.solarsystemid2,
                samples=[observe_window(info, item_id, type_id)
                         for item_id, type_id in ((60003754, 1529), (60003460, 3871))])


result = observe()
