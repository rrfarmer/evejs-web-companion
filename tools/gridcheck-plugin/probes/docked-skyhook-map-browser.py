import blue
import evetypes
from eve.client.script.ui.shared.maps.browserwindow import MapBrowserWnd
from eve.client.script.ui.structure.structureBrowser.entries.skyhookEntry import SkyhookEntry
from utillib import KeyVal


def row_menu(system_id):
    type_id = 81080
    controller = KeyVal(GetItemID=lambda: 9988400004071, GetTypeID=lambda: type_id,
                        GetSolarSystemID=lambda: system_id,
                        GetCategoryID=lambda: evetypes.GetCategoryID(type_id))
    return SkyhookEntry.GetMenu.im_func(KeyVal(controller=controller))


def location_entry(entries):
    return next((item for item in entries if hasattr(item, 'GetLabelPath')
                 and item.GetLabelPath() == 'UI/Common/Location'), None)


def observe():
    if MapBrowserWnd.GetIfOpen():
        raise RuntimeError('Map Browser is already open')
    remote = 30000208
    location = location_entry(row_menu(remote))
    entries = {item.GetLabelPath(): item for item in location.GetSubMenuData() if hasattr(item, 'GetLabelPath')}
    star = entries['UI/Commands/ShowLocationOnMap']
    browser_entry = entries['UI/Inflight/ShowInMapBrowser']
    try:
        browser_entry.ExecuteFunction()
        for _ in range(40):
            window = MapBrowserWnd.GetIfOpen()
            if window:
                browser = window.sr.browser
                if len(browser.children) == 4 and all(browser.ids) and not browser.loadingMap:
                    break
            blue.pyos.synchro.SleepWallclock(100)
        else:
            raise RuntimeError('Map Browser did not load the remote Skyhook system')
        return dict(build=3698585, station=session.stationid, system=remote,
                    currentLocation=location_entry(row_menu(session.solarsystemid2)) is not None,
                    location=location.GetText(), map=star.GetText(), browser=browser_entry.GetText(),
                    ids=[list(ids) for ids in browser.ids])
    finally:
        window = MapBrowserWnd.GetIfOpen()
        if window:
            window.Close()


result = observe()
