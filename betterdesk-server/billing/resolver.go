package billing

import (
	"fmt"
	"strconv"

	"github.com/unitronix/betterdesk-server/db"
)

// ContractResolver resolves the effective billing contract for a device.
type ContractResolver interface {
	GetActiveBillingContract(targetType, targetKey string) (*db.BillingContract, error)
	GetDeviceOrgID(deviceID string) (string, error)
}

// PanelContext supplies folder and device-group membership for resolution.
type PanelContext interface {
	ListFolderAssignments() (map[string]int64, error)
	ListDeviceGroupGUIDsForPeer(peerID string) ([]string, error)
}

// ResolveContractForDevice picks the most specific active contract:
// device > folder > device_group > org.
func ResolveContractForDevice(resolver ContractResolver, panel PanelContext, deviceID string) (*db.BillingContract, error) {
	if resolver == nil || deviceID == "" {
		return nil, nil
	}

	if c, err := resolver.GetActiveBillingContract(db.BillingTargetDevice, deviceID); err != nil {
		return nil, err
	} else if c != nil {
		return c, nil
	}

	if panel != nil {
		if folders, err := panel.ListFolderAssignments(); err == nil {
			if folderID, ok := folders[deviceID]; ok && folderID > 0 {
				key := strconv.FormatInt(folderID, 10)
				if c, err := resolver.GetActiveBillingContract(db.BillingTargetFolder, key); err != nil {
					return nil, err
				} else if c != nil {
					return c, nil
				}
			}
		}
		if groups, err := panel.ListDeviceGroupGUIDsForPeer(deviceID); err == nil {
			for _, guid := range groups {
				if guid == "" {
					continue
				}
				if c, err := resolver.GetActiveBillingContract(db.BillingTargetDeviceGroup, guid); err != nil {
					return nil, err
				} else if c != nil {
					return c, nil
				}
			}
		}
	}

	orgID, err := resolver.GetDeviceOrgID(deviceID)
	if err != nil {
		return nil, err
	}
	if orgID == "" {
		return nil, nil
	}
	return resolver.GetActiveBillingContract(db.BillingTargetOrg, orgID)
}

// NormalizeContractTarget maps legacy org_id bodies to target_type/target_key.
func NormalizeContractTarget(body *db.BillingContract) error {
	if body == nil {
		return fmt.Errorf("contract body required")
	}
	if body.TargetType == "" && body.OrgID != "" {
		body.TargetType = db.BillingTargetOrg
		body.TargetKey = body.OrgID
	}
	if body.TargetType == "" || body.TargetKey == "" {
		return fmt.Errorf("target_type and target_key required")
	}
	switch body.TargetType {
	case db.BillingTargetOrg, db.BillingTargetDeviceGroup, db.BillingTargetFolder, db.BillingTargetDevice:
		return nil
	default:
		return fmt.Errorf("invalid target_type")
	}
}
