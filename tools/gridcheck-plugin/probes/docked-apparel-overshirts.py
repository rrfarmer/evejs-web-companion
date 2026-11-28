import re

import blue


def observe():
    loc = next(row for row in cfg.paperdollModifierLocations if row.modifierKey == 'topouter')
    rows = []
    for row in cfg.paperdollResources:
        gender = 'female' if row.resGender == 0 else 'male'
        path = row.resPath.lower()
        if row.typeID is not None or not re.match(r'^topouter/[^/]+/types/[^/]+\.type$', path):
            continue
        asset = 'res:/graphics/character/%s/paperdoll/%s' % (gender, path)
        rows.append(dict(id=row.paperdollResourceID, gender=gender, path=path,
                         races=list(row.empireRestrictions or ()), exists=blue.paths.exists(asset)))
    rows.sort(key=lambda row: row['id'])
    return dict(build=3698585, station=session.stationid, location=loc.modifierLocationID, rows=rows)


result = observe()
