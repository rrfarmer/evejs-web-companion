# The types the 3698585 client deploys when dropped on space (navigation.OnDropData: spacecomponents HasDeployComponent,
# then deploy.DeployAction - LaunchFromShip with maxQty 1, CannotDeployRequireFleet where the component requiresFleet
# and the pilot has no fleet). Read from a running client:
#   node tools/gridcheck/bin/gridcheck.js client eval --json --file tools/client-extract/deployableTypes.py
# The page reads it as _local/client-assets/<build>/deployableTypes.json: {source, types: [[typeID, requiresFleet], ...]}.
from spacecomponents.common.componentConst import DEPLOY_CLASS
from spacecomponents.common.data import get_space_component_for_type, get_type_ids_with_space_component
out = []
for typeID in get_type_ids_with_space_component(DEPLOY_CLASS):
    attrs = get_space_component_for_type(typeID, DEPLOY_CLASS)
    out.append([int(typeID), bool(getattr(attrs, 'requiresFleet', False))])
result = {'types': sorted(out)}
