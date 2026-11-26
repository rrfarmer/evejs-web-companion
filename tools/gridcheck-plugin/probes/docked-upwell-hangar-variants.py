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

def effect_counts(model):
    counts = {}
    for group in model.effectChildren:
        if group.name == 'layouts':
            for item in group.objects:
                counts[item.name] = counts.get(item.name, 0) + 1
    return counts

def measure():
    station = session.stationid
    slash = sm.RemoteSvc('slash')
    views = sm.GetService('viewState')
    result = []
    for kind, expected_type in [('athanor', const.typeRefineryAthanor), ('raitaru', const.typeEngineeringComplexRaitaru)]:
        record = {'kind': kind}
        result.append(record)
        sid = None
        try:
            seed = str(slash.SlashCmd('/upwell seed %s CodexHangarVariant' % kind))
            match = re.search(r'(?<!\d)\d{10,}(?!\d)', seed)
            if not match:
                record['fixtureError'] = seed
                continue
            sid = long(match.group(0))
            slash.SlashCmd('/tr me %d' % sid)
            view = views.GetView('hangar')
            def loaded():
                return (session.structureid == sid and views.IsPrimaryViewActive('hangar')
                        and view.GetStationType() == expected_type and view.currentHangarGraphicID == 25235
                        and getattr(view, 'activeHangarModel', None) and getattr(view, 'activeHangarScene', None))
            if not wait_for(loaded):
                record['fixtureError'] = 'No loaded variant hangar'
                record['graphic'] = getattr(view, 'currentHangarGraphicID', None)
                continue
            args = (view.GetStationType(), view.GetActiveShipTypeID(), sid)
            record.update(typeID=args[0], model=view.currentHangarGraphicID, scene=hangars.GetHangarSceneGraphicID(*args),
                          faction=hangars.GetHangarFactionDataOverwrite(*args), layout=effect_counts(view.activeHangarModel))
        except Exception as exc:
            record['fixtureError'] = str(exc)
        finally:
            if sid:
                slash.SlashCmd('/tr me %d' % station)
                wait_for(lambda: session.stationid == station)
                slash.SlashCmd('/upwell remove %d' % sid)
    return result

result = measure()
