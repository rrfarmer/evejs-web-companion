from eve.client.script.ui.shared.fleet.fleetbroadcast import BroadcastSettings
import sharedSettings
import sharedSettings.client


def observe():
    if BroadcastSettings.GetIfOpen():
        raise RuntimeError('Broadcast Settings is already open')
    wnd = BroadcastSettings.Open()
    try:
        drag = wnd.OnFilterDragged('Codex Broadcast Settings')[0]
        keyval = sm.RemoteSvc('sharedSettingsMgr').StoreSettingLinkAndGetID(sharedSettings.SHARED_SETTING_BROADCAST, drag.data)
        key = sharedSettings.GetSettingKeyFromKeyVal(keyval, 'ItemFilterLoadingError')
        restored = sharedSettings.GetDataFromSettingKey(key, None, 'ItemFilterLoadingError')
        return dict(build=3698585, station=session.stationid, guid=drag.__guid__, label=drag.label,
                    rows=drag.data['broadcastSettings'], reloaded=restored['broadcastSettings'],
                    url=sharedSettings.client.format_shared_settings_url(key))
    finally:
        wnd.Close()


result = observe()
