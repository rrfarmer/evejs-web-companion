# Read the installed skyhook configuration labels and reinforcement variance.
from eve.common.lib import appConst
from localization import GetByLabel
labels = ('UI/DustLink/ConfigureOrbital', 'UI/OrbitalSkyhook/ConfigWnd/SkyhookConfig',
          'UI/OrbitalSkyhook/ConfigWnd/SkyhookSettings', 'UI/OrbitalSkyhook/ConfigWnd/TakeAccess',
          'UI/PI/OrbitalConfigurationWindow/ReinforcementExit',
          'UI/OrbitalSkyhook/ConfigWnd/CustomsOfficeSettings', 'UI/AclBookmarks/NoAccessList',
          'UI/Common/Submit', 'UI/Common/Cancel')
result = {'labels': [GetByLabel(label) for label in labels],
          'variance': sm.GetService('clientDogmaStaticSvc').GetTypeAttribute(81080, appConst.attributeReinforcementVariance),
          'stationManager': bool(session.corprole & appConst.corpRoleStationManager)}
