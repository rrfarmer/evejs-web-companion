import re

import blue


def observe():
    character = sm.GetService('character')
    location = next(row for row in cfg.paperdollModifierLocations if row.modifierKey == 'topmiddle')
    stock = []
    for row in cfg.paperdollResources:
        gender = 'female' if row.resGender == 0 else 'male'
        path = row.resPath.lower()
        if row.typeID is not None or not re.match(r'^topmiddle/tanktop[fm]01/types/[^/]+\.type$', path):
            continue
        asset = 'res:/graphics/character/%s/paperdoll/%s' % (gender, path)
        fields = character.factory.GetItemType(asset, gender=gender)
        stock.append(dict(id=row.paperdollResourceID, gender=gender, path=path, races=list(row.empireRestrictions or ()),
                          exists=blue.paths.exists(asset), fields=list(fields) if fields is not None else None))
    return dict(station=session.stationid, location=location.modifierLocationID,
                stock=sorted(stock, key=lambda row: row['id']))


result = observe()
