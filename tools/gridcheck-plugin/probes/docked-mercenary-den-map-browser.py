import blue
from carbonui.control.contextMenu.menuDataFactory import CreateMenuDataFromRawTuples
from carbonui.util.bunch import Bunch
from eve.client.script.ui.shared.maps.browserwindow import MapBrowserWnd
from eve.client.script.ui.shared.planet.mecDen.mercDenWnd import MyMercDensWnd
from evelink.client.handlers.show_info.link import location_link


def open_from(menu):
    entries = {entry.GetLabelPath(): entry for entry in menu.GetEntries() if entry is not None}
    star = entries['UI/Commands/ShowLocationOnMap']
    browser_entry = entries['UI/Inflight/ShowInMapBrowser']
    try:
        browser_entry.ExecuteFunction()
        for _ in range(40):
            window = MapBrowserWnd.GetIfOpen()
            if window:
                browser = window.sr.browser
                if len(browser.children) == 4 and all(browser.ids) and not browser.loadingMap:
                    return dict(map=star.GetText(), browser=browser_entry.GetText(), ids=[list(ids) for ids in browser.ids])
            blue.pyos.synchro.SleepWallclock(100)
        raise RuntimeError('Map Browser did not load the operation system')
    finally:
        window = MapBrowserWnd.GetIfOpen()
        if window:
            window.Close()


def observe():
    if MapBrowserWnd.GetIfOpen():
        raise RuntimeError('Map Browser is already open')
    system = 30000142
    den = Bunch(item_id=990000013581, type_id=85230, has_complete_info=True, solar_system_id=system)
    row = MyMercDensWnd.GetMercDenMenu(None, Bunch(sr=Bunch(node=Bunch(mercDenEntryInfo=den))))
    location = next(entry for entry in row.GetEntries()
                    if entry is not None and entry.GetLabelPath() == 'UI/Common/Location')
    link = CreateMenuDataFromRawTuples(sm.GetService('link').get_menu(location_link(system).url))
    return dict(build=3698585, station=session.stationid, system=system,
                roster=open_from(location.GetSubMenuData()), operation=open_from(link))


result = observe()
