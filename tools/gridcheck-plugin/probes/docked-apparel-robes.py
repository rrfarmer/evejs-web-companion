import re

import blue
from charactercreator import const


def observe():
    loc = next(row for row in cfg.paperdollModifierLocations if row.modifierKey == 'outer')
    rows = []
    for row in cfg.paperdollResources:
        gender = 'female' if row.resGender == 0 else 'male'
        path = row.resPath.lower()
        if not re.match(r'^outer/robe[^/]+/types/[^/]+\.type$', path):
            continue
        asset = 'res:/graphics/character/%s/paperdoll/%s' % (gender, path)
        rows.append(dict(id=row.paperdollResourceID, gender=gender, path=path, typeID=row.typeID,
                         races=list(row.empireRestrictions or ()), exists=blue.paths.exists(asset)))
    rows.sort(key=lambda row: row['id'])
    dependency, required, style = const.TUCKMAPPING['outer']
    root = 'res:/graphics/character/male/paperdoll/%s/%s' % (dependency, style)
    hood = dict((key, dict(path=path, exists=blue.paths.exists('%s/%s' % (root, path))))
                for key, path in [('v0', 'down.gr2'), ('v1', 'v1/down.gr2'), ('v2', 'v2/covered.gr2')])
    return dict(build=3698585, station=session.stationid, location=loc.modifierLocationID,
                variationKey=loc.variationKey, dependency=dependency, requires=list(required), hood=hood, rows=rows)


result = observe()
