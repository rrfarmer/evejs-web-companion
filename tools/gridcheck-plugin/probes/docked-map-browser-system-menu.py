import blue
from carbonui.control.contextMenu.menuDataFactory import CreateMenuDataFromRawTuples
from carbonui.uicore import uicore
from eve.client.script.ui.shared.maps.browserwindow import MapBrowserWnd


def observe():
    if MapBrowserWnd.GetIfOpen():
        raise RuntimeError('Map Browser is already open')
    try:
        here, remote = session.solarsystemid2, 30000142
        uicore.cmd.OpenMapBrowser(here)
        for _ in range(60):
            window = MapBrowserWnd.GetIfOpen()
            if window and len(window.sr.browser.children) == 4 and not window.sr.browser.loadingMap:
                break
            blue.pyos.synchro.SleepWallclock(100)
        else:
            raise RuntimeError('Map Browser did not load four panels')
        browser = window.sr.browser
        constellation = browser.children[2]

        def menu_at(item_id):
            if not any(item.itemID == item_id for item in constellation.mapitems):
                raise RuntimeError('Solar system is outside the selected constellation')
            saved = constellation.GetPick
            try:
                constellation.GetPick = lambda: [item_id]
                menu = CreateMenuDataFromRawTuples(constellation.GetMenu())
                return {item.GetLabelPath(): item for item in menu.GetEntries() if item is not None and item.GetLabelPath()}
            finally:
                constellation.GetPick = saved

        current_menu = menu_at(here)
        remote_menu = menu_at(remote)
        remote_menu['UI/Inflight/ShowInMapBrowser'].ExecuteFunction()
        for _ in range(60):
            if browser.ids[3] == [remote] and not browser.loadingMap:
                break
            blue.pyos.synchro.SleepWallclock(100)
        else:
            raise RuntimeError('Marker did not select the remote solar system')
        return dict(build=3698585, station=session.stationid, here=here, remote=remote,
                    current=dict((key, item.GetText()) for key, item in current_menu.items()),
                    menu=dict((key, item.GetText()) for key, item in remote_menu.items()),
                    ids=[list(ids) for ids in browser.ids], retained=MapBrowserWnd.GetIfOpen() is window)
    finally:
        window = MapBrowserWnd.GetIfOpen()
        if window:
            window.Close()


result = observe()
