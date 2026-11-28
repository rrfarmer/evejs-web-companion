import blue
from carbonui.control.contextMenu.menuDataFactory import CreateMenuDataFromRawTuples
from eve.client.script.ui.shared.info.infoConst import TAB_PLANETARYPRODUCTIONPLANET
from eve.client.script.ui.shared.info.panels.planetaryProductionPlanet import PanelPlanetaryProductionPlanet
from utillib import KeyVal


def observe():
    info = sm.GetService('info')
    samples = []
    for type_id, item_id in [(2016, 40009229), (11, 40009236)]:
        window = info.ShowInfo(type_id, item_id, parentID=session.solarsystemid2, new=1)
        try:
            for _ in range(70):
                content = getattr(window, 'info_content', None)
                if content and hasattr(content, 'data') and not window.isLoading:
                    break
                blue.pyos.synchro.SleepWallclock(100)
            else:
                raise RuntimeError('Planet Show Info did not finish loading')
            rows = PanelPlanetaryProductionPlanet.GetScrollList.im_func(KeyVal(typeID=type_id))
            samples.append(dict(typeID=type_id, itemID=item_id, tab=TAB_PLANETARYPRODUCTIONPLANET in content.dynamicTabs,
                                header=rows[0].label if rows else None,
                                resources=[dict(typeID=row.typeID, label=row.label) for row in rows[1:]]))
        finally:
            window.Close()
    first = samples[0]['resources'][0]['typeID']
    menu = CreateMenuDataFromRawTuples(sm.GetService('menu').GetMenuFromItemIDTypeID(None, first, includeMarketDetails=True))
    return dict(build=3698585, station=session.stationid, samples=samples,
                menu=[item.GetText() for item in menu.GetEntries() if item is not None and item.GetLabelPath()])


result = observe()
