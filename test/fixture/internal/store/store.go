package store

import "example.com/demo/internal/model"

type Repo struct {
	items map[string]model.Item
}

func NewRepo() *Repo {
	return &Repo{items: map[string]model.Item{}}
}

func (r *Repo) Put(item model.Item) error {
	_ = item
	return nil
}
