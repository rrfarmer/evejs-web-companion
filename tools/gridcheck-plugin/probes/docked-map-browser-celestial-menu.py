import blue
from carbonui.control.contextMenu.menuDataFactory import CreateMenuDataFromRawTuples
from carbonui.uicore import uicore
from eve.client.script.ui.shared.maps import map2D
from eve.client.script.ui.shared.maps.browserwindow import MapBrowserWnd


def item_menus(chart, pick):
    get_pick = chart.GetPick
    try:
        chart.GetPick = lambda: pick
        return describe(CreateMenuDataFromRawTuples(chart.GetMenu()))
    finally:
        chart.GetPick = get_pick


def describe(menu):
    return [dict(path=entry.GetLabelPath(), text=entry.GetText(),
                 sub=describe(entry.GetSubMenuData()) if entry.GetLabelPath() == 'UI/Map/Map2D/menuLocationEntry' else [])
            for entry in menu.GetEntries() if entry is not None and entry.GetLabelPath()]


def observe():
    if MapBrowserWnd.GetIfOpen():
        raise RuntimeError('Map Browser is already open')
    abstract_setting = settings.user.ui.Get('solarsystemmapabstract', 0)
    try:
        settings.user.ui.Set('solarsystemmapabstract', 0)
        uicore.cmd.OpenMapBrowser(session.solarsystemid2)
        for _ in range(60):
            window = MapBrowserWnd.GetIfOpen()
            if window and len(window.sr.browser.children) == 4 and not window.sr.browser.loadingMap:
                break
            blue.pyos.synchro.SleepWallclock(100)
        else:
            raise RuntimeError('Map Browser panels did not finish loading')
        chart = next(child for child in window.sr.browser.children[3].children if getattr(child, 'drawlevel', None) == 4)
        wanted = (6, 7, 8, 9, 10, 15)
        individual = []
        for group in wanted:
            item = next((item for item in chart.mapitems if item.groupID == group and item.itemID in chart.cordsAsPortion), None)
            if item:
                individual.append(dict(id=item.itemID, group=group, name=item.itemName,
                                       menu=item_menus(chart, [item.itemID])))

        class Cursor(object):
            def __getattr__(self, name):
                return getattr(uicore.uilib, name)

        class Core(object):
            uilib = Cursor()

            def __getattr__(self, name):
                return getattr(uicore, name)

        core = map2D.uicore
        map2D.uicore = Core()
        try:
            size = max(1, chart.absoluteRight - chart.absoluteLeft)
            candidates = []
            for item_id in chart.cordsAsPortion:
                coordinates = chart.GetCordsByKeyAsPortion(item_id, size)
                map2D.uicore.uilib.x = chart.absoluteLeft + coordinates[0]
                map2D.uicore.uilib.y = chart.absoluteTop + coordinates[1]
                picked = chart.GetPick()
                if 2 <= len(picked) <= 5:
                    candidates.append((len(picked), item_id, picked))
            _, anchor, picked = min(candidates)
        finally:
            map2D.uicore = core
        return dict(build=3698585, station=session.stationid, system=session.solarsystemid2,
                    hoverGroups=list(chart.mouseHoverGroups), abstract=bool(chart.allowAbstract), individual=individual,
                    overlap=dict(anchor=anchor, picked=picked, menu=item_menus(chart, picked)))
    finally:
        window = MapBrowserWnd.GetIfOpen()
        if window:
            window.Close()
        settings.user.ui.Set('solarsystemmapabstract', abstract_setting)


result = observe()
