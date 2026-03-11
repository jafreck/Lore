package main

func h() {}
func reg() {
	r.GET("/health", h)
	r.POST("/users", h)
}
