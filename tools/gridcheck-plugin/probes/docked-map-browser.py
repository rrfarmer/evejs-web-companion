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


def observe_alignment(window):
    samples = []
    for _ in range(2):
        label, action, args = window.GetMenu()[0]
        action(*args)
        blue.pyos.synchro.SleepWallclock(200)
        samples.append(dict(label=label.GetText(), direction=args[0], rect=list(window.GetAbsolute()),
                            stored=settings.user.ui.Get('mapbrowseralign')))
    return samples


def zoom_controls(window):
    nodes = [window]
    labels = set()
    while nodes:
        node = nodes.pop()
        text = getattr(node, 'text', None)
        if text in ('1x', '2x', '4x'):
            labels.add(text)
        nodes.extend(getattr(node, 'children', ()) or ())
    return sorted(labels)


def observe_connections(browser):
    result = []
    for drawlevel, map_view in enumerate(browser.children[:3], 1):
        groups, outside = map_view.GetConnectionData(map_view.ids, drawlevel - 1, drawlevel)
        result.append(dict(groups=[sorted(set(tuple(sorted(pair)) for pair in group
                                               if all(item_id in map_view.cordsAsPortion for item_id in pair)))
                                   for group in groups],
                           outside=sorted(set(item.itemID for item in outside))))
    return result


def observe():
    if MapBrowserWnd.GetIfOpen():
        raise RuntimeError('Map Browser is already open')
    original_align = settings.user.ui.Get('mapbrowseralign', 'right')
    try:
        settings.user.ui.Set('mapbrowseralign', 'right')
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
        connections = observe_connections(browser)
        rect = list(window.GetAbsolute())
        desktop = [uicore.desktop.width, uicore.desktop.height]
        menu.ShowInMapBrowser(30000144)
        second = [list(ids) for ids in browser.ids]
        return dict(build=3698585, station=session.stationid, windowID=window.windowID,
                    caption=window.GetCaption(), first=first, second=second, desktop=desktop, rect=rect,
                    same=MapBrowserWnd.GetIfOpen() is window, sections=len(browser.children),
                    neocom=list(sm.GetService('neocom').GetNeocomContainer().GetAbsolute()),
                    firstOrbits=first_orbits, secondOrbits=orbit_geometry(browser),
                    alignment=observe_alignment(window), zoomControls=zoom_controls(window),
                    connections=connections)
    finally:
        window = MapBrowserWnd.GetIfOpen()
        if window:
            window.Close()
        settings.user.ui.Set('mapbrowseralign', original_align)


result = observe()
