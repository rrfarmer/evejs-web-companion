import blue
from eve.client.script.ui.shared.maps.browserwindow import MapBrowserWnd
from eve.client.script.ui.shared.market.orders import OrderEntry
from utillib import KeyVal
import localization


def order_menu(station, system):
    order = KeyVal(charID=session.charid, typeID=34, stationID=station, solarSystemID=system)
    entry = KeyVal(sr=KeyVal(node=KeyVal(order=order)), OnClick=lambda: None,
                   CancelOffer=lambda *args: None, ModifyPrice=lambda *args: None)
    return OrderEntry.GetMenu.im_func(entry)


def observe():
    if MapBrowserWnd.GetIfOpen():
        raise RuntimeError('Map Browser is already open')
    system = 30000142
    fallback = next(item[1] for item in order_menu(0, system) if isinstance(item, tuple)
                    and hasattr(item[0], 'GetText') and item[0].GetText() == localization.GetByLabel('UI/Common/SolarSystem'))
    map_label = localization.GetByLabel('UI/Commands/ShowLocationOnMap')
    browser_label = localization.GetByLabel('UI/Inflight/ShowInMapBrowser',
                                             locationType=localization.GetByLabel('UI/Common/LocationTypes/SolarSystem'))
    entries = {}
    for item in fallback:
        if hasattr(item, 'ExecuteFunction'):
            entries[item.GetText()] = item.ExecuteFunction
        elif isinstance(item, (list, tuple)) and len(item) > 2 and hasattr(item[0], 'GetText'):
            entries[item[0].GetText()] = (lambda action, args: lambda: action(*args))(item[1], item[2])
    try:
        entries[browser_label]()
        for _ in range(40):
            window = MapBrowserWnd.GetIfOpen()
            if window and window.sr.browser.ids:
                break
            blue.pyos.synchro.SleepWallclock(100)
        else:
            raise RuntimeError('The market order did not finish opening Map Browser')
        return dict(build=3698585, station=session.stationid, system=system, caption=window.GetCaption(),
                    ids=[list(ids) for ids in window.sr.browser.ids], map=map_label,
                    browser=browser_label, mapAvailable=map_label in entries)
    finally:
        window = MapBrowserWnd.GetIfOpen()
        if window:
            window.Close()


result = observe()
