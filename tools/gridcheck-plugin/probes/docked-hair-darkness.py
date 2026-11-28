from eve.client.script.ui.login.charcreation_new.charCreationUtils import GradientSlider
from eve.client.script.ui.services.character import Character, ccConst
from eve.common.script.paperDoll.paperDollDefinitions import AppearanceRow
from localization import GetByLabel
from utillib import KeyVal


def observe():
    pilot = session.charid
    hair = KeyVal(colorizeData=((0.8, 0.6, 0.4, 1.0), (0.3, 0.2, 0.1, 1.0), (0.6, 0.5, 0.4, 1.0)),
                  pattern=None, patternData=None, specularColorData=None)
    brow = KeyVal(SetColorVariation=lambda name: None)
    beard = [KeyVal(SetColorVariation=lambda name: None) for _ in range(2)]
    modifiers = {ccConst.hair: hair, ccConst.eyebrows: brow, ccConst.beard: beard}

    class Doll(object):
        SetHairDarkness = Character.SetHairDarkness.__func__
        SynchronizeHairColors = Character.SynchronizeHairColors.__func__

        def GetModifierByCategory(self, character_id, category, getAll=False):
            return modifiers[category]

    doll = Doll()
    doll.characterMetadata = {pilot: KeyVal(hairDarkness=-1.0)}
    slider = KeyVal(_value=-2.0, SetHandle=lambda value: None,
                    onSetValueCallback=lambda slider: doll.SetHairDarkness(pilot, slider._value))
    samples = []
    for value in (-1.0, 0.0, 0.35, 0.5, 1.0, 1.5):
        GradientSlider.SetValue.__func__(slider, value)
        saved = AppearanceRow(doll.characterMetadata[pilot].hairDarkness)
        samples.append(dict(request=value, saved=saved.hairDarkness, hair=hair.colorizeData,
                            brows=list(brow.colorizeData), beards=[list(item.colorizeData) for item in beard]))
    stem = 'UI/Login/CharacterCreation/AssetMenu/'
    return dict(station=session.stationid, samples=samples,
                female=GetByLabel(stem + 'EyebrowsColor'), male=GetByLabel(stem + 'FacialHairColor'))


result = observe()
