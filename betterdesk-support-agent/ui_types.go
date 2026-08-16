package main

type consentRequest struct {
	sessionID string
	operator  string
	response  chan bool
}
