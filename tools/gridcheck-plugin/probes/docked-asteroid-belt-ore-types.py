import blue
import appConst
from carbonui.control.contextMenu.menuDataFactory import CreateMenuDataFromRawTuples
from eve.client.script.ui.shared.info.infoConst import TAB_ATTIBUTES, TAB_DESCRIPTION
from eve.client.script.ui.shared.info.panels.panelAsteroidBeltOreTypes import PanelAsteroidBeltOreTypes
from localization import GetByLabel
from mining.client.ore_const import BASE_TYPE_BY_VARIANT_TYPE


def observe_belt(info, item_id):
    window = info.ShowInfo(appConst.typeAsteroidBelt, item_id, parentID=session.solarsystemid2, new=1)
    panel = None
    try:
        for _ in range(70):
            content = getattr(window, 'info_content', None)
            if content and hasattr(content, 'data') and not window.isLoading:
                break
            blue.pyos.synchro.SleepWallclock(100)
        else:
            raise RuntimeError('Belt information was not ready')
        panel = PanelAsteroidBeltOreTypes(asteroid_belt_id=item_id)
        try:
            rows = [dict(typeID=node.typeID, label=node.label, getIcon=node.getIcon)
                    for node in panel.GetScrollList()]
            error = None
        except (TypeError, ValueError) as exception:
            rows = []
            error = str(exception)
        return dict(itemID=item_id, header=content.captionText, tabs=list(content.dynamicTabs),
                    description=content.data[TAB_DESCRIPTION]['text'], rows=rows, error=error,
                    attributes=len(content.data[TAB_ATTIBUTES]['items']))
    finally:
        if panel:
            panel.Close()
        window.Close()


def observe():
    info = sm.GetService('info')
    menu = CreateMenuDataFromRawTuples(sm.GetService('menu').GetMenuFromItemIDTypeID(None, 1228, includeMarketDetails=True))
    return dict(build=3698585, station=session.stationid, system=session.solarsystemid2,
                oreLabel=GetByLabel('UI/Agency/OreTypesInBelt'),
                samples=[observe_belt(info, item_id) for item_id in (40009232, 40009245, None)],
                variantBases=sorted(BASE_TYPE_BY_VARIANT_TYPE.items()),
                menu=[entry.GetText() for entry in menu.GetEntries() if entry is not None and entry.GetLabelPath()])


result = observe()
