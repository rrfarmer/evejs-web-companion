from types import FunctionType

from localization import GetByLabel


def observe():
    service = sm.GetService('character')
    method = service.GetAvailableTypesByCategory.__func__
    player_choices = FunctionType(method.func_code, dict(method.func_globals, ROLE_CONTENT=0),
                                  method.func_name, method.func_defaults, method.func_closure)
    clothing = sm.GetService('cc')
    slots = ('bottommiddle', 'accessories/masks')
    scopes = {slot: {row.paperdollResourceID: row.typeID for row in cfg.paperdollResources
                     if row.resPath.lower().startswith(slot + '/') and row.typeID is not None}
              for slot in slots}
    owned = clothing.GetMyApparel()
    rows = []
    for gender, type_id in (('female', 54714), ('male', 54718)):
        for projected in (False, True):
            try:
                if projected:
                    clothing.availableTypeIDs = {type_id, 34047}
                for slot in slots:
                    choices = player_choices(service, slot, gender, 2)
                    rows.append(dict(gender=gender, projected=projected, slot=slot,
                                     choices=sorted((resource_id, scopes[slot].get(resource_id))
                                                    for resource_id, _, _ in choices)))
            finally:
                clothing.availableTypeIDs = owned
    return dict(station=session.stationid, owned=sorted(owned), samples=rows,
                content_role=bool(session.role & method.func_globals['ROLE_CONTENT']),
                label=GetByLabel('UI/Login/CharacterCreation/AssetMenu/ModifierNames/Clothing/Masks'),
                location=next(row.modifierLocationID for row in cfg.paperdollModifierLocations
                              if row.modifierKey == 'accessories/masks'))


result = observe()
