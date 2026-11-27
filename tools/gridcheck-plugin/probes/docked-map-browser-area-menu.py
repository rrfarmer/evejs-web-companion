import blue
from carbonui.control.contextMenu.menuDataFactory import CreateMenuDataFromRawTuples
from carbonui.uicore import uicore
from eve.client.script.ui.shared.maps.browserwindow import MapBrowserWnd


def menu_at(chart, item_id):
    if not chart.GetItemRecord(item_id)[0]:
        raise RuntimeError('Marker is absent from the chart: %s' % item_id)
    saved = chart.GetPick
    try:
        chart.GetPick = lambda: [item_id]
        menu = CreateMenuDataFromRawTuples(chart.GetMenu())
        entries = [item for item in menu.GetEntries() if item is not None and item.GetLabelPath()]
        return ([item.GetText() for item in entries],
                next((item for item in entries if item.GetLabelPath() == 'UI/Inflight/ShowInMapBrowser'), None))
    finally:
        chart.GetPick = saved


def observe():
    if MapBrowserWnd.GetIfOpen():
        raise RuntimeError('Map Browser is already open')
    try:
        uicore.cmd.OpenMapBrowser(session.solarsystemid2)
        for _ in range(60):
            window = MapBrowserWnd.GetIfOpen()
            if window and len(window.sr.browser.children) == 4 and not window.sr.browser.loadingMap:
                break
            blue.pyos.synchro.SleepWallclock(100)
        else:
            raise RuntimeError('Map Browser panels did not finish loading')
        browser = window.sr.browser
        menu_at(browser.children[1], session.constellationid)[1].ExecuteFunction()
        blue.pyos.synchro.SleepWallclock(400)
        kept = len(browser.children)
        samples = {}
        for key, index, target in [('constellation', 1, 20000021), ('region', 0, 10000033)]:
            labels, action = menu_at(browser.children[index], target)
            if action:
                action.ExecuteFunction()
                for _ in range(60):
                    if len(browser.children) == index + 2 and browser.ids[index + 1] == [target] and not browser.loadingMap:
                        break
                    blue.pyos.synchro.SleepWallclock(100)
                else:
                    raise RuntimeError('Map Browser did not select the %s' % key)
            samples[key] = dict(id=target, labels=labels, hasMapBrowser=bool(action),
                                panels=[ids[0] for ids in browser.ids[:len(browser.children)]])
        return dict(build=3698585, station=session.stationid, kept=kept,
                    retained=MapBrowserWnd.GetIfOpen() is window, samples=samples)
    finally:
        window = MapBrowserWnd.GetIfOpen()
        if window:
            window.Close()


result = observe()
