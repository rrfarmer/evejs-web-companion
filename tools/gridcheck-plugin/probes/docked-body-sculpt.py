from types import FunctionType

from eve.client.script.ui.services.character import Character, MUSCLE_MODIFIER_PATH, THIN_MODIFIER_PATH, WEIGHT_MODIFIER_PATH
from eve.common.script.paperDoll.paperDollDefinitions import DNAConverter
from eve.common.script.paperDoll.paperDollDataManagement import ModifierLoader
from localization import GetByLabel
from utillib import KeyVal


def observe():
    pilot = session.charid
    paths = THIN_MODIFIER_PATH + WEIGHT_MODIFIER_PATH + MUSCLE_MODIFIER_PATH
    modifiers = {path: KeyVal(weight=0.0) for path in paths}
    animation = []
    params = KeyVal(SetControlParameter=lambda key, value: animation.append([key, value]))
    method = Character.SetCharacterWeight.__func__
    set_weight = FunctionType(method.func_code, dict(method.func_globals,
        animparams=KeyVal(GetParamsPerAvatar=lambda avatar, char_id: params)),
        method.func_name, method.func_defaults, method.func_closure)

    class DollEditor(object):
        SetCharacterWeight = set_weight
        GetCharacterWeight = Character.GetCharacterWeight.__func__
        SetCharacterMuscularity = Character.SetCharacterMuscularity.__func__
        GetCharacterMuscularity = Character.GetCharacterMuscularity.__func__

        def GetModifierByPath(self, char_id, path):
            return modifiers[path]

    editor = DollEditor()
    data = ModifierLoader.LoadBlendshapeLimits('res:/graphics/character/global/facesetup/scultpinglimits/default_blendshape_limits.yaml')
    limits = data['limits']
    editor.characters = {pilot: KeyVal(doll=KeyVal(buildDataManager=KeyVal(modifierLimits=limits)), avatar=None)}
    converter = DNAConverter()
    samples = []
    for weight, muscle in ((0.0, 0.0), (0.25, 0.2), (0.5, 0.5), (0.75, 0.8), (1.0, 1.0)):
        editor.SetCharacterWeight(pilot, weight, doUpdate=False)
        editor.SetCharacterMuscularity(pilot, muscle, doUpdate=False)
        morphs = {path.split('/')[-1]: value.weight for path, value in modifiers.iteritems() if value.weight}
        rows = converter.ExtractSculptRowsFromDollInfo(dict(bodyShapes=morphs))
        samples.append(dict(weight=editor.GetCharacterWeight(pilot), muscle=editor.GetCharacterMuscularity(pilot),
                            morphs=morphs, rows=sorted([list(row) for row in rows])))
    slot_names = ('topmiddle', 'bottomouter', 'feet')
    slots = {row.modifierKey: row.modifierLocationID for row in cfg.paperdollModifierLocations if row.modifierKey in slot_names}
    stem = 'UI/Login/CharacterCreation/AssetMenu/ModifierNames/'
    return dict(station=session.stationid, samples=samples, slots=slots, animation=animation,
                limits={name: limits[name] for name in ('thinshape', 'fatshape', 'muscularshape')},
                labels=[GetByLabel(stem + name) for name in ('Weight', 'Muscularity')])


result = observe()
