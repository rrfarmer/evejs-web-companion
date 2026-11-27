"""Read the emblem bindings of a Venture placed in a native modular hangar."""
import blue
import re
import trinity
from evegraphics.CosmeticsLoader import CosmeticsLoader
from evegraphics.gateLogoConst import LOGO_BLACK_ICON_PATH
from inventorycommon import const

def wait_for(predicate):
    for _ in xrange(80):
        value = predicate()
        if value:
            return value
        blue.synchro.SleepWallclock(250)
    return None

def session_ready():
    return not session.nextSessionChange or session.nextSessionChange <= blue.os.GetSimTime()

def images(model):
    return sorted(resource.resourcePath for attachment in model.attachments
                  if isinstance(attachment, trinity.EveBannerSet)
                  for resource in attachment.effect.resources if resource.name == 'ImageMap')

def measure():
    station = session.stationid
    if not station:
        return {'fixtureError': 'Start from an NPC station'}
    slash = sm.RemoteSvc('slash')
    inv = sm.GetService('invCache')
    skills = sm.GetService('skills')
    views = sm.GetService('viewState')
    view = views.GetView('hangar')
    service = sm.GetService('cosmeticsSvc')
    skill_type = 32918
    gained_skill = False
    structure = None
    ship = None
    try:
        skill = skills.GetSkill(skill_type, renew=1)
        if skill is None:
            reply = str(slash.SlashCmd('/giveskill me %d 1' % skill_type))
            gained_skill = 'to level I.' in reply
            if not gained_skill:
                return {'fixtureError': reply}
        elif not skill.trainedSkillLevel:
            return {'fixtureError': 'Mining Frigate injected at level zero'}
        reply = str(slash.SlashCmd('/upwell seed astrahus CodexEmblemHangar13678'))
        match = re.search(r'(?<!\d)\d{10,}(?!\d)', reply)
        if not match:
            return {'fixtureError': reply}
        structure = long(match.group(0))
        slash.SlashCmd('/tr me %d' % structure)
        if not wait_for(lambda: session.structureid == structure and views.IsPrimaryViewActive('hangar')):
            return {'fixtureError': 'Astrahus hangar did not open'}

        def inventory():
            return inv.GetInventory(const.containerHangar).List(const.flagHangar)

        old = set(item.itemID for item in inventory())
        reply = str(slash.SlashCmd('/ship Venture'))
        ship = wait_for(lambda: next((item.itemID for item in inventory()
                                     if item.typeID == 32880 and item.itemID not in old), None))
        if not ship or not wait_for(session_ready):
            return {'fixtureError': reply}
        access = sm.GetService('gameui').GetShipAccess()
        sm.StartService('sessionMgr').PerformSessionChange('board', access.Board, ship, session.shipid or structure)
        def placed_dock():
            if session.shipid != ship or view.GetActiveShipTypeID() != 32880 or view.currentHangarGraphicID != 25235:
                return None
            behaviour = view.shipBehaviour
            return next((dock for dock in list(behaviour.smallDocks or ()) + list(behaviour.bigDocks or ())
                         if dock.dockedShipItemID == ship and dock.dockedShip is not None), None)

        dock = wait_for(placed_dock)
        if dock is None:
            return {'fixtureError': 'Venture did not load in the modular hangar'}
        hull = dock.dockedShip
        loader = view.shipBehaviour.cosmeticsLoader
        equipped = service.get_enabled_ship_cosmetics(ship)
        loader.SetCosmeticsOnShip(hull, [])
        before = images(hull)
        loader.SetCosmeticsOnShip(hull, [CosmeticsLoader.CORP])
        displayed = wait_for(lambda: images(hull) if images(hull) != before else None)
        loader.SetCosmeticsOnShip(hull, [])
        after = images(hull)
        loader.SetCosmeticsOnShip(hull, equipped or [])
        names = sorted(parameter.name for parameter in hull.externalParameters)
        effects = [attachment.effect.effectFilePath for attachment in hull.attachments
                   if isinstance(attachment, trinity.EveBannerSet)]
        return dict(structureType=view.GetStationType(), shipType=view.GetActiveShipTypeID(),
                    structureID=structure, shipID=ship, hangarModel=view.currentHangarGraphicID,
                    behaviour=type(view.shipBehaviour).__name__, playerDock=bool(dock.isPlayer),
                    bindings=names, bannerEffects=effects,
                    black=LOGO_BLACK_ICON_PATH, clearedBefore=before, corporationDisplayed=displayed, clearedAfter=after,
                    emblemsDisabled=service.are_ship_emblems_disabled())
    except Exception as exc:
        return {'fixtureError': str(exc)}
    finally:
        try:
            if ship and session.shipid == ship and wait_for(session_ready):
                access = sm.GetService('gameui').GetShipAccess()
                sm.StartService('sessionMgr').PerformSessionChange('leave', access.LeaveShip, ship)
                wait_for(lambda: session.shipid != ship)
            if ship and session.shipid != ship and session.structureid == structure:
                inv.GetInventoryMgr().TrashItems([ship], structure)
        finally:
            try:
                if structure:
                    slash.SlashCmd('/tr me %d' % station)
                    if wait_for(lambda: session.stationid == station):
                        slash.SlashCmd('/upwell remove %d' % structure)
            finally:
                if gained_skill:
                    slash.SlashCmd('/removeskill me %d' % skill_type)

result = measure()
