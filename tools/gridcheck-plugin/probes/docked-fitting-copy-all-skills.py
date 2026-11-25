import evetypes
from eve.client.script.ui.shared.fittingScreen import skillRequirements
from eve.client.script.ui.shared.fittingScreen.skillRequirementsUtil import GetAllSkillsAndLevels
from localization import GetByLabel


def measure(type_ids):
    calls = []
    original_blue = skillRequirements.blue
    capture = type('ClipboardCapture', (), {'SetClipboardData': staticmethod(calls.append)})
    try:
        skillRequirements.blue = type('BlueCapture', (), {'pyos': capture})
        skillRequirements.CopyAllSkills(type_ids)
    finally:
        skillRequirements.blue = original_blue
    return {
        'types': list(type_ids),
        'typeNames': [evetypes.GetName(type_id) for type_id in type_ids],
        'skills': [[skill, level, evetypes.GetName(skill)] for skill, level in GetAllSkillsAndLevels(type_ids)],
        'text': calls[0],
    }


def observe():
    dogma = sm.GetService('clientDogmaIM').GetDogmaLocation()
    return {
        'station': session.stationid,
        'label': GetByLabel('UI/Fitting/FittingWindow/CopyAllSkills'),
        'active': measure(skillRequirements.GetAllTypeIDsMissingSkillsForShipAndContent(dogma)),
        'venture': measure(set([32880, 483, 2488, 2048])),
    }


result = observe()
