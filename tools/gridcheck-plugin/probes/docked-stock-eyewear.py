import blue
from localization import GetByLabel


def observe():
    category = 'accessories/glasses'
    service = sm.GetService('character')
    location = next(row for row in cfg.paperdollModifierLocations if row.modifierKey == category)
    stock = []
    for row in cfg.paperdollResources:
        if row.typeID is not None or not row.resPath.lower().startswith(category + '/'):
            continue
        gender = 'female' if row.resGender == 0 else 'male'
        path = 'res:/graphics/character/%s/paperdoll/%s' % (gender, row.resPath.lower())
        if blue.paths.exists(path):
            stock.append(dict(id=row.paperdollResourceID, gender=gender, path=path,
                              races=list(row.empireRestrictions or ())))
    available = []
    for gender in ('female', 'male'):
        stock_ids = {row['id'] for row in stock if row['gender'] == gender}
        for race in (1, 2, 4, 8):
            items = service.GetAvailableTypesByCategory(category, gender, race)
            available.append(dict(gender=gender, race=race,
                                  ids=sorted(asset_id for asset_id, _, _ in items if asset_id in stock_ids)))
    return dict(station=session.stationid, location=location.modifierLocationID,
                label=GetByLabel('UI/Login/CharacterCreation/AssetMenu/ModifierNames/Clothing/Glasses'),
                stock=sorted(stock, key=lambda row: row['id']), available=available)


result = observe()
