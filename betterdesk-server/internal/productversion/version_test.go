package productversion

import "testing"

func TestProduct_notEmpty(t *testing.T) {
	v := Product()
	if v == "" {
		t.Fatal("Product() returned empty string")
	}
}
