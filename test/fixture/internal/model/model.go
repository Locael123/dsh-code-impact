package model

type Item struct {
	ID   string
	Name string
}

func NewItem(id string) Item {
	return Item{ID: id}
}
