from localization import GetByMessageID
from cosmetics.common.ships.skins.static_data.skin_type import ShipSkinType

svc = sm.GetService('cosmeticsSvc')
rows = {}
for hull in (670, 32880):
    licensed = svc.GetLicensedSkinsForType(hull)
    static = list(svc.static.GetSkinsForTypeID(hull) or ())
    variants = []
    for skin in static[:6]:
        material = svc.static.materials[skin.skinMaterialID]
        variants.append(dict(skinID=skin.skinID, material=material.skinMaterialID,
                             setID=material.materialSetID, nameID=material.displayNameID,
                             name=GetByMessageID(int(material.displayNameID))))
    rows[str(hull)] = dict(licensed=[row.skinID for row in licensed or ()], catalogCount=len(static), variants=variants)
state = svc.GetAppliedSkinStateForCurrentSession(session.shipid)
result = dict(station=session.stationid, shipID=session.shipid,
              isStock=state is not None and state.skin_type == ShipSkinType.NO_SKIN, hulls=rows)
