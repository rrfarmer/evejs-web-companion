import blue
import re
from inventorycommon import const

def wait_for(predicate):
    for _ in xrange(60):
        value = predicate()
        if value:
            return value
        blue.synchro.SleepWallclock(250)
    return None

def session_change_ready():
    return not session.nextSessionChange or session.nextSessionChange <= blue.os.GetSimTime()

def measure():
    station = session.stationid
    slash = sm.RemoteSvc('slash')
    views = sm.GetService('viewState')
    view = views.GetView('hangar')
    skills = sm.GetService('skills')
    inv = sm.GetService('invCache')
    sid = None
    ship = None
    granted = []
    try:
        for skill in (3456, 20525, 20533):
            existing = skills.GetSkill(skill, renew=1)
            if existing is not None:
                if not existing.trainedSkillLevel:
                    return {'fixtureError': 'Skill already injected at level zero', 'skill': skill}
                continue
            answer = str(slash.SlashCmd('/giveskill me %d 1' % skill))
            if 'to level I.' not in answer:
                return {'fixtureError': answer}
            granted.append(skill)
        seeded = str(slash.SlashCmd('/upwell seed fortizar CodexCapitalHangar'))
        match = re.search(r'(?<!\d)\d{10,}(?!\d)', seeded)
        if not match:
            return {'fixtureError': seeded}
        sid = long(match.group(0))
        slash.SlashCmd('/tr me %d' % sid)
        if not wait_for(lambda: session.structureid == sid and views.IsPrimaryViewActive('hangar')):
            return {'fixtureError': 'No Fortizar session'}
        def inventory():
            return inv.GetInventory(const.containerHangar).List(const.flagHangar)
        old = set(item.itemID for item in inventory())
        answer = str(slash.SlashCmd('/ship Revelation'))
        ship = wait_for(lambda: next((item.itemID for item in inventory() if item.typeID == 19720 and item.itemID not in old), None))
        if not ship:
            return {'fixtureError': answer}
        if not wait_for(session_change_ready):
            return {'fixtureError': 'The boarding session timer did not clear'}
        access = sm.GetService('gameui').GetShipAccess()
        sm.StartService('sessionMgr').PerformSessionChange('board', access.Board, ship, session.shipid or sid)
        def loaded():
            return session.shipid == ship and view.currentHangarGraphicID == 25568 and getattr(view.shipBehaviour, 'playerShip', None)
        if not wait_for(loaded):
            return {'fixtureError': 'No capital hangar or placed Revelation', 'model': getattr(view, 'currentHangarGraphicID', None),
                    'shipType': view.GetActiveShipTypeID()}
        cam = view.GetCamera()
        blue.synchro.SleepWallclock(450)
        return dict(model=view.currentHangarGraphicID, shipType=view.GetActiveShipTypeID(),
                    placement=list(view.shipBehaviour.shipTranslation), shipPosition=list(view.shipBehaviour.playerShip.modelWorldPosition),
                    eye=list(cam.camStartPos), actualEye=list(cam._eyePosition),
                    pointOfInterest=list(cam.camStartPoi), fov=cam.fov, camera=cam.__class__.__name__)
    except Exception as exc:
        return {'fixtureError': str(exc)}
    finally:
        try:
            if ship and session.shipid == ship:
                if not wait_for(session_change_ready):
                    raise RuntimeError('The leave-ship session timer did not clear')
                access = sm.GetService('gameui').GetShipAccess()
                sm.StartService('sessionMgr').PerformSessionChange('leave', access.LeaveShip, ship)
                wait_for(lambda: session.shipid != ship)
            if ship and session.shipid != ship and session.structureid == sid:
                inv.GetInventoryMgr().TrashItems([ship], sid)
        finally:
            try:
                if sid:
                    slash.SlashCmd('/tr me %d' % station)
                    wait_for(lambda: session.stationid == station)
                    slash.SlashCmd('/upwell remove %d' % sid)
            finally:
                for skill in granted:
                    slash.SlashCmd('/removeskill me %d' % skill)

result = measure()
