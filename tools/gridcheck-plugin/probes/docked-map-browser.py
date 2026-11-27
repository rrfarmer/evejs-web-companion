import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.maps.browserwindow import MapBrowserWnd
from eve.client.script.ui.shared.maps.map2D import FLIPMAP
import localization


def orbit_geometry(browser):
    solar_map = next(child for child in browser.children[3].children if getattr(child, 'drawlevel', None) == 4)
    children = []
    for _, _, planet, _ in solar_map.orbs:
        for child in solar_map.GetChilds(planet.itemID, [], 0):
            position = solar_map.cordsAsPortion.get(child.itemID)
            if position:
                children.append(dict(id=child.itemID, parent=planet.itemID, x=child.x, z=child.z,
                                     parentX=planet.x, parentZ=planet.z, left=position[0], top=position[1]))
    return dict(size=solar_map.sr.sizefactorsize, factor=solar_map.sr.sizefactor,
                fill=solar_map.fillSize, flip=FLIPMAP,
                abstract=bool(settings.user.ui.Get('solarsystemmapabstract', 0)),
                children=sorted(children, key=lambda child: child['id']),
                gates=sorted([dict(id=item.itemID, x=item.x, z=item.z, position=solar_map.cordsAsPortion[item.itemID])
                              for item in solar_map.mapitems if item.groupID == 10 and item.itemID in solar_map.cordsAsPortion],
                             key=lambda gate: gate['id']),
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


def observe_abstract(browser):
    solar_map = next(child for child in browser.children[3].children if getattr(child, 'drawlevel', None) == 4)
    def select(path):
        caption = localization.GetByLabel(path)
        label, action, args = next(entry for entry in solar_map.GetMenu()
                                  if entry and hasattr(entry[0], 'GetText') and entry[0].GetText() == caption)
        action(*args)
        blue.pyos.synchro.SleepWallclock(400)
        return label.GetText()
    show = select('UI/Map/Map2D/menuShowAbstract')
    geometry = orbit_geometry(browser)
    hide = select('UI/Map/Map2D/menuShowNonAbstract')
    return dict(show=show, hide=hide, geometry=geometry, restored=not orbit_geometry(browser)['abstract'])


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
    original_abstract = settings.user.ui.Get('solarsystemmapabstract', 0)
    try:
        settings.user.ui.Set('mapbrowseralign', 'right')
        settings.user.ui.Set('solarsystemmapabstract', 0)
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
        abstract = observe_abstract(browser)
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
                    connections=connections, abstractLayout=abstract)
    finally:
        window = MapBrowserWnd.GetIfOpen()
        if window:
            window.Close()
        settings.user.ui.Set('mapbrowseralign', original_align)
        settings.user.ui.Set('solarsystemmapabstract', original_abstract)


result = observe()
