import blue
from charactercreator import const
from eve.common.script.util import paperDollUtil
from eveexceptions import UserError
from utillib import KeyVal


def jacket_removal():
    paperDollUtil.CacheRequiredModifierLocatiosn()
    by_slot = paperDollUtil.MODIFIER_LOCATION_BY_KEY
    results = {}
    for gender in ('male', 'female'):
        results[gender] = {}
        for top in ('outer', 'topouter', 'topmiddle', None):
            slots = ['bottomouter', 'feet']
            if top:
                slots.append(top)
            items = [KeyVal(modifierLocationID=by_slot[slot], paperdollResourceID=None) for slot in slots]
            try:
                results[gender][top or 'none'] = paperDollUtil.HasRequiredClothing(gender, items)
            except UserError as error:
                results[gender][top or 'none'] = error.msg
    return results


def observe():
    locations = dict((row.modifierKey, row.modifierLocationID)
                     for row in cfg.paperdollModifierLocations
                     if row.modifierKey == 'outer')
    rows = []
    for row in cfg.paperdollResources:
        gender = 'female' if row.resGender == 0 else 'male'
        path = row.resPath.lower()
        parts = path.split('/')
        if (len(parts) != 4 or parts[2] != 'types' or
                parts[0] != 'outer' or not parts[1].startswith('jacket') or row.typeID is not None):
            continue
        asset = 'res:/graphics/character/%s/paperdoll/%s' % (gender, path)
        rows.append(dict(id=row.paperdollResourceID, gender=gender, path=path,
                         races=list(row.empireRestrictions or ()), exists=blue.paths.exists(asset)))
    rows.sort(key=lambda row: row['id'])
    return dict(build=3698585, station=session.stationid, locations=locations,
                requiredTop=jacket_removal(),
                removable=[slot for slot in ('outer', 'topouter', 'topmiddle', 'bottomouter', 'feet')
                           if slot in const.REMOVEABLE], rows=rows)


result = observe()
