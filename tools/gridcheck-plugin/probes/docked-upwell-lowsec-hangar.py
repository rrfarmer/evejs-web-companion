import blue
import re
from eve.client.script.ui.view import hangarRegistry as hangars
from inventorycommon import const

def wait_for(predicate):
    for _ in xrange(48):
        if predicate():
            return True
        blue.synchro.SleepWallclock(250)
    return False

def measure():
    station = session.stationid
    low_station = 60005203
    slash = sm.RemoteSvc('slash')
    service = sm.GetService('viewState')
    view = service.GetView('hangar')
    sid = None
    try:
        slash.SlashCmd('/tr me %d' % low_station)
        if not wait_for(lambda: session.stationid == low_station and session.solarsystemid2 == 30002813):
            return {'fixtureError': 'No Tama station session'}
        seeded = str(slash.SlashCmd('/upwell seed fortizar CodexLowsecHangar'))
        match = re.search(r'(?<!\d)\d{10,}(?!\d)', seeded)
        if match is None:
            return {'fixtureError': seeded}
        sid = long(match.group(0))
        slash.SlashCmd('/tr me %d' % sid)
        if not wait_for(lambda: session.structureid == sid and service.IsPrimaryViewActive('hangar')
                        and view.GetStationType() == const.typeCitadelFortizar and view.currentHangarGraphicID == 25605):
            return {'fixtureError': 'No low-security modular hangar', 'model': getattr(view, 'currentHangarGraphicID', None)}
        def graphics(ship_type):
            args = (view.GetStationType(), ship_type, sid)
            return dict(name=hangars.GetHangarType(*args), model=hangars.GetHangarModelGraphicID(*args),
                        scene=hangars.GetHangarSceneGraphicID(*args))
        return dict(system=session.solarsystemid2, stationType=view.GetStationType(), shipType=view.GetActiveShipTypeID(),
                    live=graphics(view.GetActiveShipTypeID()), revelation=graphics(19720))
    except Exception as exc:
        return {'fixtureError': str(exc)}
    finally:
        if sid:
            slash.SlashCmd('/tr me %d' % low_station)
            wait_for(lambda: session.stationid == low_station)
            slash.SlashCmd('/upwell remove %d' % sid)
        slash.SlashCmd('/tr me %d' % station)
        wait_for(lambda: session.stationid == station)

result = measure()
