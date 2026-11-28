from paperdoll.common import BODY_BLENDSHAPE_ZONES
from eve.common.script.paperDoll.paperDollDefinitions import DNAConverter
from eve.common.script.paperDoll.paperDollDataManagement import ModifierLoader


def observe():
    names = {zone.lower() for zone in BODY_BLENDSHAPE_ZONES}
    limits = ModifierLoader.LoadBlendshapeLimits(
        'res:/graphics/character/global/facesetup/scultpinglimits/default_blendshape_limits.yaml')['limits']
    directions = ('down', 'up', 'right', 'left', 'back', 'forward')
    locations = sorted((row.sculptLocationID, row.weightKeyPrefix) for row in cfg.paperdollSculptingLocations
                       if row.weightKeyCategory == 'bodyShapes' and row.weightKeyPrefix.lower() in names)
    shapes = {name + '_' + direction + 'shape': limits.get(name + '_' + direction + 'shape')
              for _, name in locations for direction in directions}
    edits = {'shoulders_upshape': 0.2, 'abs_forwardshape': 0.25, 'pelvis_backshape': 0.2}
    rows = DNAConverter().ExtractSculptRowsFromDollInfo(dict(bodyShapes=edits))
    return dict(station=session.stationid, locations=locations, limits=shapes, rows=sorted(list(row) for row in rows))


result = observe()
