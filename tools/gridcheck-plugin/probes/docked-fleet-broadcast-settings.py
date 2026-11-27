import blue
from eve.client.script.ui.shared.fleet.fleetbroadcast import BroadcastSettings
from eve.client.script.ui.shared.fleet.fleetBroadcastConst import LISTEN_BROADCAST_SETTING
from evefleet import BROADCAST_SHOW_OWN


def observe():
    if BroadcastSettings.GetIfOpen():
        raise RuntimeError('Broadcast Settings is already open')
    wnd = BroadcastSettings.Open()
    names = ('HealArmor', BROADCAST_SHOW_OWN)
    saved = dict((name, settings.user.ui.Get(LISTEN_BROADCAST_SETTING % name, None)) for name in names)
    fleet = sm.GetService('fleet')
    try:
        blue.pyos.synchro.SleepWallclock(350)
        rows = [dict(name=node.cfgname, label=node.label, checked=node.checked,
                     picker=node.showColorPicker, hint=node.get('hint', None))
                for node in wnd.sr.scrollBroadcasts.GetNodes()]
        me, other = session.charid, session.charid + 1
        states = []
        for armor, own in ((True, False), (False, False), (False, True)):
            fleet.SetListenBroadcast('HealArmor', armor)
            fleet.SetListenBroadcast(BROADCAST_SHOW_OWN, own)
            states.append([fleet.WantBroadcast('HealArmor', who) for who in (me, other)])
        return dict(build=3698585, station=session.stationid, rows=rows, states=states,
                    size=list(wnd.GetAbsolute())[2:], share=len(wnd.GetDataForSharing()))
    finally:
        for name in names:
            key = LISTEN_BROADCAST_SETTING % name
            if saved[name] is None:
                settings.user.ui.Delete(key)
            else:
                settings.user.ui.Set(key, saved[name])
        wnd.Close()


result = observe()
