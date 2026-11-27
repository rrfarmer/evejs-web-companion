import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.maps.browserwindow import MapBrowserWnd
from eve.client.script.ui.shared.maps.map2D import FLIPMAP


def orbit_geometry(browser):
    solar_map = next(child for child in browser.children[3].children if getattr(child, 'drawlevel', None) == 4)
    return dict(size=solar_map.sr.sizefactorsize, factor=solar_map.sr.sizefactor,
                fill=solar_map.fillSize, flip=FLIPMAP,
                abstract=bool(settings.user.ui.Get('solarsystemmapabstract', 0)),
                orbits=[dict(id=planet.itemID, radius=radius, x=planet.x, z=planet.z)
                        for _, radius, planet, _ in solar_map.orbs])


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
        first_orbits = orbit_geometry(browser)
        rect = list(window.GetAbsolute())
        desktop = [uicore.desktop.width, uicore.desktop.height]
        menu.ShowInMapBrowser(30000144)
        second = [list(ids) for ids in browser.ids]
        return dict(build=3698585, station=session.stationid, windowID=window.windowID,
                    caption=window.GetCaption(), first=first, second=second, desktop=desktop, rect=rect,
                    same=MapBrowserWnd.GetIfOpen() is window, sections=len(browser.children),
                    firstOrbits=first_orbits, secondOrbits=orbit_geometry(browser))
    finally:
        window = MapBrowserWnd.GetIfOpen()
        if window:
            window.Close()


result = observe()
