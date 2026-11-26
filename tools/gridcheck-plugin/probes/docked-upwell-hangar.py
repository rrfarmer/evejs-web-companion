import blue
import re
from eve.client.script.ui.view import hangarRegistry as hangars
from inventorycommon import const

def wait_for(predicate):
    for _ in xrange(80):
        if predicate():
            return True
        blue.synchro.SleepWallclock(250)
    return False

def measure():
    station = session.stationid
    slash = sm.RemoteSvc('slash')
    views = sm.GetService('viewState')
    sid = None
    try:
        seeded = str(slash.SlashCmd('/upwell seed astrahus CodexHangar13563'))
        match = re.search(r'(?<!\d)\d{10,}(?!\d)', seeded)
        if match is None:
            return {'fixtureError': seeded}
        sid = long(match.group(0))
        slash.SlashCmd('/tr me %d' % sid)
        if not wait_for(lambda: session.structureid == sid and views.IsPrimaryViewActive('hangar')):
            return {'fixtureError': 'No docked hangar'}
        view = views.GetView('hangar')
        if not wait_for(lambda: getattr(view, 'activeHangarModel', None) and getattr(view, 'activeShipModel', None)):
            return {'fixtureError': 'No loaded hangar or active ship'}
        def graphics(station_type, ship_type):
            args = (station_type, ship_type, sid)
            return dict(name=hangars.GetHangarType(*args), model=hangars.GetHangarModelGraphicID(*args),
                        scene=hangars.GetHangarSceneGraphicID(*args), faction=hangars.GetHangarFactionDataOverwrite(*args))
        model = view.activeHangarModel
        dock = getattr(view.shipBehaviour, 'playerDock', None)
        station_type = view.GetStationType()
        ship_type = view.GetActiveShipTypeID()
        return dict(stationType=station_type, shipType=ship_type, live=graphics(station_type, ship_type),
                    refinery=graphics(const.typeRefineryAthanor, ship_type),
                    engineering=graphics(const.typeEngineeringComplexRaitaru, ship_type),
                    capital=graphics(const.typeCitadelFortizar, 19720),
                    locators=[item.name for item in model.locatorSets],
                    layoutChildren=[child.name for child in model.effectChildren],
                    playerDock=list(dock.translation) if dock is not None else None)
    except Exception as exc:
        return {'fixtureError': str(exc)}
    finally:
        if sid:
            slash.SlashCmd('/tr me %d' % station)
            wait_for(lambda: session.stationid == station)
            slash.SlashCmd('/upwell remove %d' % sid)

result = measure()
