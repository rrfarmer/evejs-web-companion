import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.maps.browserwindow import MapBrowserWnd
from eve.client.script.ui.shared.mapView.mapViewPanel import MapViewPanel
from eve.client.script.ui.shared.mapView.settings import classic_map_enabled_setting


def observe():
    if MapBrowserWnd.GetIfOpen() or MapViewPanel.GetIfOpen() or classic_map_enabled_setting.is_enabled():
        raise RuntimeError('Close both maps and use the standard star map before observing')
    try:
        uicore.cmd.OpenMapBrowser(30000144)
        for _ in range(60):
            window = MapBrowserWnd.GetIfOpen()
            if window:
                browser = window.sr.browser
                if len(browser.children) == 4 and all(browser.ids) and not browser.loadingMap:
                    break
            blue.pyos.synchro.SleepWallclock(100)
        else:
            raise RuntimeError('Map Browser panels did not finish loading')
        result = []
        for child in browser.children:
            pointer = child.FindChild('pointer')
            action, item_id = pointer.OnClick
            action(item_id)
            for _ in range(90):
                panel = MapViewPanel.GetIfOpen()
                map_view = getattr(panel, 'mapView', None)
                if map_view and map_view.activeItemID == item_id:
                    break
                blue.pyos.synchro.SleepWallclock(100)
            else:
                raise RuntimeError('World map did not select %s' % item_id)
            blue.pyos.synchro.SleepWallclock(650)
            result.append(dict(id=item_id, selected=map_view.activeItemID, zoom=map_view.camera.GetZoomDistance(),
                               width=pointer.width, height=pointer.height, hint=pointer.hint,
                               texture=pointer.texturePath, retained=MapBrowserWnd.GetIfOpen() is window))
        refused = []
        for item_id in (11000001, 21000001, 31000001):
            try:
                browser.ShowOnMap(item_id)
            except UserError as error:
                refused.append(dict(id=item_id, dialog=error.msg,
                                    text=cfg.GetMessage(error.msg, error.dict, onNotFound='raise').text))
        return dict(build=3698585, station=session.stationid, panels=result, refused=refused)
    finally:
        panel = MapViewPanel.GetIfOpen()
        if panel:
            panel.Close()
        window = MapBrowserWnd.GetIfOpen()
        if window:
            window.Close()


result = observe()
