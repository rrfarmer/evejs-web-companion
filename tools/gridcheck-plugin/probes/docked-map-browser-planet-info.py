import blue
from eve.client.script.ui.shared.info.infoConst import TAB_ATTIBUTES, TAB_ORBITALBODIES, DATA_BUTTONS


def observe():
    item_id = 40009229
    info = sm.GetService('info')
    window = info.ShowInfo(2016, item_id, parentID=session.solarsystemid2, new=1)
    try:
        for _ in range(70):
            content = getattr(window, 'info_content', None)
            if content and hasattr(content, 'data') and not window.isLoading:
                break
            blue.pyos.synchro.SleepWallclock(100)
        else:
            raise RuntimeError('Planet Show Info did not finish loading')
        def entries(tab):
            return [dict(label=getattr(node, 'label', None), text=getattr(node, 'text', None),
                         id=getattr(node, 'itemID', None)) for node in content.data[tab]['items']]
        return dict(build=3698585, station=session.stationid, system=session.solarsystemid2,
                    id=item_id, caption=window.GetCaption(), name=cfg.evelocations.Get(item_id).locationName,
                    attributes=entries(TAB_ATTIBUTES), orbitals=entries(TAB_ORBITALBODIES),
                    actions=[entry[0] for entry in content.data[DATA_BUTTONS]],
                    statistics=dict(info.GetCelestialStatisticsForCelestial(item_id, 7)))
    finally:
        window.Close()


result = observe()
