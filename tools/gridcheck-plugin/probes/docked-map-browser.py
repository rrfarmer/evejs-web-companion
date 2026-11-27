import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.maps.browserwindow import MapBrowserWnd


def observe():
    if MapBrowserWnd.GetIfOpen():
        raise RuntimeError('Map Browser is already open')
    try:
        menu = sm.GetService('menu')
        menu.ShowInMapBrowser(30000142)
        window = MapBrowserWnd.GetIfOpen()
        if not window:
            raise RuntimeError('Map Browser did not open')
        browser = window.sr.browser
        for _ in range(30):
            if len(browser.children) == 4:
                break
            blue.pyos.synchro.SleepWallclock(100)
        first = [list(ids) for ids in browser.ids]
        rect = list(window.GetAbsolute())
        desktop = [uicore.desktop.width, uicore.desktop.height]
        menu.ShowInMapBrowser(30000144)
        second = [list(ids) for ids in browser.ids]
        return dict(build=3698585, station=session.stationid, windowID=window.windowID,
                    caption=window.GetCaption(), first=first, second=second, desktop=desktop, rect=rect,
                    same=MapBrowserWnd.GetIfOpen() is window, sections=len(browser.children))
    finally:
        window = MapBrowserWnd.GetIfOpen()
        if window:
            window.Close()


result = observe()
